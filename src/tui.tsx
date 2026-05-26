import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { ScannedRepo, scanWorkspace } from './scanner.js';
import { getGitStatus, pullRepository, RepoGitStatus } from './git.js';
import {
  loadWorkspacePackages,
  calculateDrifts,
  getRepoDependencyStatuses,
  installDependency,
  PackageDependencies,
  DependencyDrift,
  PackageStatus,
} from './dependencies.js';
import { taskRunner } from './runner.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length > len ? str.substring(0, len - 3) + '...' : str;
}

function getProgressBar(current: number, total: number): string {
  const width = 12;
  const progress = total > 0 ? Math.round((current / total) * width) : 0;
  return '█'.repeat(progress) + '░'.repeat(width - progress);
}

interface TUIProps {
  initialWorkspacePath: string;
}

export function AppTUI({ initialWorkspacePath }: TUIProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 30;
  const [repos, setRepos] = useState<ScannedRepo[]>([]);
  const [gitStatuses, setGitStatuses] = useState<Record<string, RepoGitStatus>>({});
  const [pkgConfigs, setPkgConfigs] = useState<PackageDependencies[]>([]);
  const [pkgDrifts, setPkgDrifts] = useState<Map<string, DependencyDrift>>(new Map());
  const [pkgStatuses, setPkgStatuses] = useState<Record<string, PackageStatus[]>>({});
  
  const [selectedRepoIdx, setSelectedRepoIdx] = useState<number>(0);
  const [selectedScriptIdx, setSelectedScriptIdx] = useState<number>(0);
  const [selectedDepIdx, setSelectedDepIdx] = useState<number>(0);
  const [activePane, setActivePane] = useState<'repos' | 'details' | 'dependencies'>('repos');
  const [isLogsExpanded, setIsLogsExpanded] = useState<boolean>(false);
  const [isUpdatingDep, setIsUpdatingDep] = useState<boolean>(false);
  const [updateDepStatus, setUpdateDepStatus] = useState<{ packageName: string; success: boolean; message: string } | null>(null);

  const [pullStatus, setPullStatus] = useState<{ repoPath: string; success: boolean; message: string } | null>(null);
  const [isPulling, setIsPulling] = useState<boolean>(false);
  const [pullAllProgress, setPullAllProgress] = useState<{ current: number; total: number; repoName: string } | null>(null);
  const [pullAllResults, setPullAllResults] = useState<{ success: number; failed: number; total: number } | null>(null);
  const [scanning, setScanning] = useState<boolean>(true);
  const [logTrigger, setLogTrigger] = useState<number>(0);

  const [animationTick, setAnimationTick] = useState(0);

  const selectedRepo = repos[selectedRepoIdx];
  const selectedRepoPkg = selectedRepo
    ? pkgConfigs.find(p => p.repoPath === selectedRepo.path)
    : null;
  const availableScripts = selectedRepoPkg ? Object.keys(selectedRepoPkg.scripts) : [];
  const selectedScript = availableScripts[selectedScriptIdx];
  const shownDeps = pkgStatuses[selectedRepo?.path]
    ? pkgStatuses[selectedRepo.path].filter(status => status.hasDrift || status.isOutdated)
    : [];

  const spinner = SPINNER_FRAMES[animationTick % SPINNER_FRAMES.length];

  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const triggerUpdate = () => {
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
    }
    updateTimerRef.current = setTimeout(() => {
      setLogTrigger(prev => prev + 1);
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, []);

  const hasRunningTasks = pkgConfigs.some(pkg =>
    Object.keys(pkg.scripts).some(script =>
      taskRunner.getTaskStatus(pkg.repoPath, script) === 'running'
    )
  );

  const shouldAnimate = scanning || isPulling || !!pullAllProgress || hasRunningTasks || isUpdatingDep;

  useEffect(() => {
    if (!shouldAnimate) return;
    const timer = setInterval(() => {
      setAnimationTick(t => t + 1);
    }, 250);
    return () => clearInterval(timer);
  }, [shouldAnimate]);

  const lastTaskStatuses = useRef<Record<string, string>>({});
  const logUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const unsubscribe = taskRunner.addListener(() => {
      let statusChanged = false;
      const newStatuses: Record<string, string> = {};
      for (const repo of repos) {
        const repoPkgInfo = pkgConfigs.find(p => p.repoPath === repo.path);
        const scriptsList = repoPkgInfo ? Object.keys(repoPkgInfo.scripts) : [];
        for (const script of scriptsList) {
          const status = taskRunner.getTaskStatus(repo.path, script);
          newStatuses[`${repo.path}::${script}`] = status;
          if (lastTaskStatuses.current[`${repo.path}::${script}`] !== status) {
            statusChanged = true;
          }
        }
      }
      lastTaskStatuses.current = newStatuses;

      if (statusChanged) {
        setLogTrigger(prev => prev + 1);
        return;
      }

      if (isLogsExpanded) {
        if (logUpdateTimerRef.current) return;
        logUpdateTimerRef.current = setTimeout(() => {
          logUpdateTimerRef.current = null;
          setLogTrigger(prev => prev + 1);
        }, 200);
      }
    });

    return () => {
      unsubscribe();
      if (logUpdateTimerRef.current) {
        clearTimeout(logUpdateTimerRef.current);
      }
    };
  }, [repos, pkgConfigs, isLogsExpanded]);

  const doScanAndRefresh = async () => {
    setScanning(true);
    const scanned = await scanWorkspace(initialWorkspacePath);
    setRepos(scanned);
    setScanning(false);

    if (scanned.length === 0) return;

    const configs = await loadWorkspacePackages(scanned);
    setPkgConfigs(configs);

    const drifts = calculateDrifts(configs);
    setPkgDrifts(drifts);

    const newGitStatuses: Record<string, RepoGitStatus> = {};
    const newPkgStatuses: Record<string, PackageStatus[]> = {};

    await Promise.all(
      scanned.map(async (repo) => {
        const gitInfo = await getGitStatus(repo.path);
        newGitStatuses[repo.path] = gitInfo;

        const depStatuses = await getRepoDependencyStatuses(
          repo.name,
          configs,
          drifts,
          triggerUpdate
        );
        newPkgStatuses[repo.path] = depStatuses;
      })
    );

    setGitStatuses(newGitStatuses);
    setPkgStatuses(newPkgStatuses);
  };

  const performDependencyUpdate = async (repoPath: string, packageName: string, version: string) => {
    setIsUpdatingDep(true);
    setUpdateDepStatus(null);
    const res = await installDependency(repoPath, packageName, version);
    setIsUpdatingDep(false);
    setUpdateDepStatus({ packageName, ...res });
    await doScanAndRefresh();
    setTimeout(() => {
      setUpdateDepStatus(null);
    }, 5000);
  };

  useEffect(() => {
    doScanAndRefresh();
    const interval = setInterval(async () => {
      if (repos.length === 0) return;
      const newGitStatuses: Record<string, RepoGitStatus> = {};
      for (const repo of repos) {
        const gitInfo = await getGitStatus(repo.path);
        newGitStatuses[repo.path] = gitInfo;
      }
      setGitStatuses(prev => ({ ...prev, ...newGitStatuses }));
    }, 7000);

    return () => clearInterval(interval);
  }, [initialWorkspacePath]);

  useEffect(() => {
    setSelectedScriptIdx(0);
    setSelectedDepIdx(0);
  }, [selectedRepoIdx]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      taskRunner.killAll();
      exit();
      return;
    }

    if (key.tab) {
      setActivePane(prev => {
        if (prev === 'repos') {
          if (availableScripts.length > 0) return 'details';
          if (shownDeps.length > 0) return 'dependencies';
          return 'repos';
        }
        if (prev === 'details') {
          if (shownDeps.length > 0) return 'dependencies';
          return 'repos';
        }
        return 'repos';
      });
      return;
    }

    if (input === 'l' || input === 'L') {
      setIsLogsExpanded(prev => !prev);
      return;
    }

    if (input === 'r' || input === 'R') {
      doScanAndRefresh();
      return;
    }

    if ((input === 'p' || input === 'P') && selectedRepo && !isPulling && !pullAllProgress) {
      setIsPulling(true);
      setPullStatus(null);
      pullRepository(selectedRepo.path).then((res) => {
        setIsPulling(false);
        setPullStatus({ repoPath: selectedRepo.path, ...res });
        
        getGitStatus(selectedRepo.path).then((gitInfo) => {
          setGitStatuses(prev => ({ ...prev, [selectedRepo.path]: gitInfo }));
        });

        setTimeout(() => {
          setPullStatus(null);
        }, 4000);
      });
      return;
    }

    if ((input === 'a' || input === 'A') && repos.length > 0 && !isPulling && !pullAllProgress) {
      setPullAllResults(null);
      const total = repos.length;
      let success = 0;
      let failed = 0;

      (async () => {
        for (let i = 0; i < repos.length; i++) {
          const repo = repos[i];
          setPullAllProgress({ current: i + 1, total, repoName: repo.name });

          const res = await pullRepository(repo.path);
          if (res.success) {
            success++;
          } else {
            failed++;
          }

          const gitInfo = await getGitStatus(repo.path);
          setGitStatuses(prev => ({ ...prev, [repo.path]: gitInfo }));
        }

        setPullAllProgress(null);
        setPullAllResults({ success, failed, total });

        setTimeout(() => {
          setPullAllResults(null);
        }, 6000);
      })();
      return;
    }

    if (key.upArrow) {
      if (activePane === 'repos') {
        setSelectedRepoIdx(prev => (prev > 0 ? prev - 1 : repos.length - 1));
      } else if (activePane === 'details') {
        setSelectedScriptIdx(prev => (prev > 0 ? prev - 1 : availableScripts.length - 1));
      } else if (activePane === 'dependencies') {
        setSelectedDepIdx(prev => (prev > 0 ? prev - 1 : shownDeps.length - 1));
      }
      return;
    }

    if (key.downArrow) {
      if (activePane === 'repos') {
        setSelectedRepoIdx(prev => (prev < repos.length - 1 ? prev + 1 : 0));
      } else if (activePane === 'details') {
        setSelectedScriptIdx(prev => (prev < availableScripts.length - 1 ? prev + 1 : 0));
      } else if (activePane === 'dependencies') {
        setSelectedDepIdx(prev => (prev < shownDeps.length - 1 ? prev + 1 : 0));
      }
      return;
    }

    if (key.return || input === ' ') {
      if (activePane === 'details' && selectedRepo && selectedScript) {
        const currentStatus = taskRunner.getTaskStatus(selectedRepo.path, selectedScript);
        if (currentStatus === 'running') {
          taskRunner.stopTask(selectedRepo.path, selectedScript);
        } else {
          taskRunner.startTask(selectedRepo.name, selectedRepo.path, selectedScript);
        }
      } else if (activePane === 'dependencies' && selectedRepo) {
        const depToUpdate = shownDeps[selectedDepIdx];
        if (depToUpdate && depToUpdate.latestVersion && !isUpdatingDep) {
          performDependencyUpdate(selectedRepo.path, depToUpdate.packageName, depToUpdate.latestVersion);
        }
      }
      return;
    }
  });

  if (scanning && repos.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box flexDirection="row" alignItems="center">
          <Text color="cyan">{spinner} </Text>
          <Text bold color="cyan">GitYard Workspace Manager</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Scanning workspace directories...</Text>
        </Box>
      </Box>
    );
  }

  if (repos.length === 0) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor="red">
        <Text color="red" bold>🔴 No Git Repositories Found</Text>
        <Text>Gityard scans immediate subdirectories of the current path for `.git` folders.</Text>
        <Text dimColor>Path: {initialWorkspacePath}</Text>
        <Box marginTop={1}>
          <Text color="yellow">Press [Q] to exit.</Text>
        </Box>
      </Box>
    );
  }

  const isAnyTaskRunningInRepo = (repoPath: string, scriptsList: string[]): boolean => {
    return scriptsList.some(s => taskRunner.getTaskStatus(repoPath, s) === 'running');
  };

  return (
    <Box flexDirection="column" width="100%" padding={1}>
      <Box justifyContent="space-between" marginBottom={1} borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false} borderColor="gray" paddingBottom={1}>
        <Box flexDirection="row" alignItems="center">
          <Text color="cyan" bold>◈ GitYard</Text>
          <Text dimColor> ─ Workspace Manager</Text>
          {scanning && <Text color="yellow">  {spinner} scanning...</Text>}
        </Box>
        <Text dimColor>{repos.length} repos │ {initialWorkspacePath}</Text>
      </Box>

      <Box flexDirection="row" height={Math.max(6, isLogsExpanded ? terminalRows - 21 : terminalRows - 14)}>
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={activePane === 'repos' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Box marginBottom={1}>
            <Text bold color={activePane === 'repos' ? 'cyan' : 'white'}>
              📂 REPOSITORIES
            </Text>
          </Box>

          {repos.map((repo, idx) => {
            const isSelected = idx === selectedRepoIdx;
            const status = gitStatuses[repo.path];
            const repoPkgInfo = pkgConfigs.find(p => p.repoPath === repo.path);
            const scriptsList = repoPkgInfo ? Object.keys(repoPkgInfo.scripts) : [];
            const hasTaskActive = isAnyTaskRunningInRepo(repo.path, scriptsList);

            let statusIcon = '●';
            let statusLabel = 'Clean';
            let statusColor = 'green';
            
            if (status) {
              if (status.conflictedCount > 0) {
                statusIcon = '●';
                statusLabel = 'Conflict';
                statusColor = 'red';
              } else if (status.uncommittedCount > 0 || status.untrackedCount > 0) {
                statusIcon = '●';
                statusLabel = `⚡ +${status.uncommittedCount}/${status.untrackedCount}`;
                statusColor = 'yellow';
              } else if (status.behind > 0) {
                statusIcon = '●';
                statusLabel = `Pending Pull`;
                statusColor = 'yellow';
              }
            }

            const prefix = isSelected ? '❯ ' : '  ';
            const displayColor = isSelected
              ? activePane === 'repos'
                ? 'cyan'
                : 'white'
              : 'gray';

            return (
              <Box key={repo.path} justifyContent="space-between">
                <Box>
                  <Text>
                    <Text color={displayColor} bold={isSelected}>
                      {prefix}
                      <Text color={statusColor}>{statusIcon}</Text> {repo.name}
                    </Text>
                    {status && (
                      <Text dimColor={!isSelected} color="gray">
                        {` [${status.branch}${status.ahead > 0 ? ` ↑${status.ahead}` : ''}${status.behind > 0 ? ` ↓${status.behind}` : ''}]`}
                      </Text>
                    )}
                  </Text>
                </Box>
                <Box>
                  <Text>
                    {hasTaskActive && <Text color="green">{spinner} </Text>}
                    <Text color={statusColor} dimColor={!isSelected}>
                      {statusLabel}
                    </Text>
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={activePane === 'details' || activePane === 'dependencies' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          {selectedRepo ? (
            <Box flexDirection="column" height="100%">
              <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false} borderColor="gray" paddingBottom={1} marginBottom={1} flexDirection="column">
                <Text bold color="yellow">📦 {selectedRepo.name.toUpperCase()}</Text>
                {gitStatuses[selectedRepo.path] && (
                  <Box flexDirection="row" marginTop={1}>
                    <Text dimColor>Branch: </Text>
                    <Text color="white">{gitStatuses[selectedRepo.path].branch}</Text>
                    <Text dimColor>  │  Sync: </Text>
                    <Text color={gitStatuses[selectedRepo.path].ahead > 0 ? 'green' : 'white'}>↑{gitStatuses[selectedRepo.path].ahead}</Text>
                    <Text dimColor> / </Text>
                    <Text color={gitStatuses[selectedRepo.path].behind > 0 ? 'yellow' : 'white'}>↓{gitStatuses[selectedRepo.path].behind}</Text>
                  </Box>
                )}
              </Box>

              {availableScripts.length > 0 ? (
                <Box flexDirection="column" marginBottom={1}>
                  <Text bold color={activePane === 'details' ? 'cyan' : 'white'}>
                    🏃 NPM Scripts:
                  </Text>
                  {availableScripts.map((scriptName, idx) => {
                    const isSelected = idx === selectedScriptIdx;
                    const isScriptFocused = isSelected && activePane === 'details';
                    const runStatus = taskRunner.getTaskStatus(selectedRepo.path, scriptName);
                    
                    let statusIcon = '○';
                    let statusText = 'idle';
                    let statusColor = 'gray';
                    
                    if (runStatus === 'running') {
                      statusIcon = spinner;
                      statusText = 'running';
                      statusColor = 'green';
                    } else if (runStatus === 'failed') {
                      statusIcon = '✖';
                      statusText = 'failed';
                      statusColor = 'red';
                    } else if (runStatus === 'success') {
                      statusIcon = '✓';
                      statusText = 'done';
                      statusColor = 'green';
                    }

                    return (
                      <Box key={scriptName} justifyContent="space-between">
                        <Text color={isScriptFocused ? 'cyan' : isSelected ? 'white' : 'gray'} bold={isSelected}>
                          {isSelected ? '❯ ' : '  '}
                          {scriptName} <Text dimColor>─ {truncate(selectedRepoPkg?.scripts[scriptName] || '', 20)}</Text>
                        </Text>
                        <Text color={statusColor} bold={runStatus === 'running'}>
                          {statusIcon} {statusText}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              ) : (
                <Box marginBottom={1}>
                  <Text dimColor>No NPM scripts found.</Text>
                </Box>
              )}

              <Box flexDirection="column" marginTop={1}>
                <Text bold color={activePane === 'dependencies' ? 'cyan' : 'white'}>
                  📦 Dependency Status:
                </Text>
                {shownDeps.length > 0 ? (
                  shownDeps.slice(0, 3).map((status, idx) => {
                    const isSelected = idx === selectedDepIdx;
                    const isDepFocused = isSelected && activePane === 'dependencies';
                    
                    let driftDetail = '';
                    if (status.hasDrift && status.driftVersions) {
                      const otherRepos = Object.entries(status.driftVersions)
                        .filter(([repo]) => repo !== selectedRepo.name)
                        .map(([repo, ver]) => `${repo}: ${ver}`)
                        .join(', ');
                      driftDetail = ` (drift: ${otherRepos})`;
                    }

                    const prefix = isSelected ? '❯ ' : '  ';
                    const displayColor = isDepFocused ? 'cyan' : isSelected ? 'white' : 'yellow';

                    return (
                      <Text key={status.packageName} color={displayColor} bold={isSelected} dimColor={!isSelected && !isDepFocused}>
                        {prefix}▲ {status.packageName}: {status.currentVersion}
                        {status.isOutdated && ` → ${status.latestVersion}`}
                        {driftDetail}
                      </Text>
                    );
                  })
                ) : (
                  <Text color="green">✓ All packages up-to-date & synchronized</Text>
                )}
                {shownDeps.length > 3 && (
                  <Text dimColor>
                    ... and {shownDeps.length - 3} more issues
                  </Text>
                )}
              </Box>
            </Box>
          ) : (
            <Text dimColor>No repository selected</Text>
          )}
        </Box>
      </Box>

      <Box height={2} marginTop={1} flexDirection="column">
        {isPulling && (
          <Text color="cyan">{spinner} Pulling updates for {selectedRepo?.name}...</Text>
        )}
        {isUpdatingDep && (
          <Text color="cyan">{spinner} Updating dependency...</Text>
        )}
        {!isUpdatingDep && updateDepStatus && (
          <Text color={updateDepStatus.success ? 'green' : 'red'}>
            {updateDepStatus.success ? '✓' : '✖'} {updateDepStatus.message}
          </Text>
        )}
        {!isPulling && pullStatus && pullStatus.repoPath === selectedRepo?.path && (
          <Text color={pullStatus.success ? 'green' : 'red'}>
            {pullStatus.success ? '✓' : '✖'} {pullStatus.message}
          </Text>
        )}
        {pullAllProgress && (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color="cyan">{spinner} Pull All: </Text>
              <Text bold color="white">{pullAllProgress.current}/{pullAllProgress.total}</Text>
              <Text dimColor> ─ Pulling {pullAllProgress.repoName}...</Text>
            </Box>
            <Box>
              <Text color="cyan">{getProgressBar(pullAllProgress.current, pullAllProgress.total)}</Text>
            </Box>
          </Box>
        )}
        {!pullAllProgress && pullAllResults && (
          <Text color={pullAllResults.failed === 0 ? 'green' : 'yellow'} bold>
            {pullAllResults.failed === 0 ? '✓' : '▲'} Pull All complete: {pullAllResults.success}/{pullAllResults.total} succeeded{pullAllResults.failed > 0 ? `, ${pullAllResults.failed} failed` : ''}
          </Text>
        )}
      </Box>

      {isLogsExpanded && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          height={6}
          marginTop={1}
        >
          <Box justifyContent="space-between">
            <Text bold color="yellow">
              📋 Logs: {selectedRepo?.name} {selectedScript ? `› ${selectedScript}` : ''}
            </Text>
            <Text dimColor>[L to Collapse]</Text>
          </Box>
          
          {selectedRepo && selectedScript ? (
            <Box flexDirection="column" marginTop={1}>
              {taskRunner.getLogs(selectedRepo.path, selectedScript).slice(-2).map((logLine, index) => (
                <Text key={index} wrap="truncate" dimColor>
                  {logLine}
                </Text>
              ))}
              {taskRunner.getLogs(selectedRepo.path, selectedScript).length === 0 && (
                <Text dimColor>No logs. Press Space on a script to start execution.</Text>
              )}
            </Box>
          ) : (
            <Text dimColor>Select a script to view logs.</Text>
          )}
        </Box>
      )}

      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" marginTop={1} paddingY={0}>
        <Text>
          <Text color="cyan" bold>Tab</Text><Text dimColor> Switch  </Text>
          <Text color="cyan" bold>▲▼</Text><Text dimColor> Navigate  </Text>
          <Text color="cyan" bold>Space</Text><Text dimColor>{activePane === 'dependencies' ? ' Update' : ' Run'}  </Text>
          <Text color="cyan" bold>P</Text><Text dimColor> Pull  </Text>
          <Text color="cyan" bold>A</Text><Text dimColor> Pull All  </Text>
          <Text color="cyan" bold>R</Text><Text dimColor> Refresh  </Text>
          <Text color="cyan" bold>L</Text><Text dimColor> Logs  </Text>
          <Text color="cyan" bold>Q</Text><Text dimColor> Quit</Text>
        </Text>
      </Box>
    </Box>
  );
}
