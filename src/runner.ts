import { spawn, ChildProcess } from 'node:child_process';

export interface RunningTask {
  repoName: string;
  repoPath: string;
  scriptName: string;
  status: 'running' | 'stopped' | 'failed' | 'success';
  pid?: number;
}

class TaskRunnerManager {
  private processes = new Map<string, ChildProcess>();
  private logs = new Map<string, string[]>();
  private statuses = new Map<string, RunningTask['status']>();
  private listeners = new Set<() => void>();

  constructor() {
    // Clean up all running background tasks on exit
    process.on('exit', () => this.killAll());
    process.on('SIGINT', () => {
      this.killAll();
      process.exit();
    });
    process.on('SIGTERM', () => {
      this.killAll();
      process.exit();
    });
  }

  private getKey(repoPath: string, scriptName: string): string {
    return `${repoPath}::${scriptName}`;
  }

  public getTaskStatus(repoPath: string, scriptName: string): RunningTask['status'] {
    return this.statuses.get(this.getKey(repoPath, scriptName)) || 'stopped';
  }

  public getLogs(repoPath: string, scriptName: string): string[] {
    return this.logs.get(this.getKey(repoPath, scriptName)) || [];
  }

  public addListener(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public startTask(repoName: string, repoPath: string, scriptName: string) {
    const key = this.getKey(repoPath, scriptName);
    if (this.processes.has(key)) return;

    this.logs.set(key, [`[Gityard] Starting npm run ${scriptName}...`]);
    this.statuses.set(key, 'running');
    this.notify();

    // Spawn the npm command detached to allow process group killing
    const child = spawn('npm', ['run', scriptName], {
      cwd: repoPath,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: true,
      detached: true,
    });

    this.processes.set(key, child);

    const appendLog = (data: Buffer) => {
      const text = data.toString('utf8');
      const currentLogs = this.logs.get(key) || [];
      const lines = text.split(/\r?\n/);
      
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      
      currentLogs.push(...lines);
      
      // Limit to last 500 lines to avoid high memory usage
      if (currentLogs.length > 500) {
        currentLogs.splice(0, currentLogs.length - 500);
      }
      
      this.logs.set(key, currentLogs);
      this.notify();
    };

    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    child.on('error', (err) => {
      const currentLogs = this.logs.get(key) || [];
      currentLogs.push(`[Gityard Error] Process failure: ${err.message}`);
      this.logs.set(key, currentLogs);
      this.statuses.set(key, 'failed');
      this.processes.delete(key);
      this.notify();
    });

    child.on('exit', (code) => {
      const currentLogs = this.logs.get(key) || [];
      currentLogs.push(`[Gityard] Process exited with code ${code}`);
      this.logs.set(key, currentLogs);
      this.statuses.set(key, code === 0 ? 'success' : 'failed');
      this.processes.delete(key);
      this.notify();
    });
  }

  public stopTask(repoPath: string, scriptName: string) {
    const key = this.getKey(repoPath, scriptName);
    const child = this.processes.get(key);
    if (!child) return;

    const currentLogs = this.logs.get(key) || [];
    currentLogs.push(`[Gityard] Terminating task process...`);
    this.logs.set(key, currentLogs);
    this.notify();

    if (child.pid) {
      try {
        // Kill the whole process group
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }

  public killAll() {
    for (const [key, child] of this.processes.entries()) {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    }
    this.processes.clear();
  }
}

export const taskRunner = new TaskRunnerManager();
