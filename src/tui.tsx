import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { ScannedRepo, scanWorkspace } from './scanner.js';
import { getGitStatus, pullRepository, RepoGitStatus } from './git.js';
import {
  loadWorkspacePackages,
  calculateDrifts,
  getRepoDependencyStatuses,
  PackageDependencies,
  DependencyDrift,
  PackageStatus,
} from './dependencies.js';
import { taskRunner } from './runner.js';

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length > len ? str.substring(0, len - 3) + '...' : str;
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
  
  // Navigation & UI States
  const [selectedRepoIdx, setSelectedRepoIdx] = useState<number>(0);
  const [selectedScriptIdx, setSelectedScriptIdx] = useState<number>(0);
  const [activePane, setActivePane] = useState<'repos' | 'details'>('repos');
  const [isLogsExpanded, setIsLogsExpanded] = useState<boolean>(false);
  
  // Action Feedback
  const [pullStatus, setPullStatus] = useState<{ repoPath: string; success: boolean; message: string } | null>(null);
  const [isPulling, setIsPulling] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(true);
  const [logTrigger, setLogTrigger] = useState<number>(0); // Ticked by task runner logs

  const selectedRepo = repos[selectedRepoIdx];
  const selectedRepoPkg = selectedRepo
    ? pkgConfigs.find(p => p.repoPath === selectedRepo.path)
    : null;
  const availableScripts = selectedRepoPkg ? Object.keys(selectedRepoPkg.scripts) : [];
  const selectedScript = availableScripts[selectedScriptIdx];

  // 1. Listen to Task Runner logs
  useEffect(() => {
    const unsubscribe = taskRunner.addListener(() => {
      setLogTrigger(prev => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // 2. Scan Workspace & Poll statuses
  const doScanAndRefresh = async () => {
    setScanning(true);
    const scanned = await scanWorkspace(initialWorkspacePath);
    setRepos(scanned);
    setScanning(false);

    if (scanned.length === 0) return;

    // Load package configs & calculate drift
    const configs = await loadWorkspacePackages(scanned);
    setPkgConfigs(configs);

    const drifts = calculateDrifts(configs);
    setPkgDrifts(drifts);

    // Initial git & dependency status fetch
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
          () => {
            // Trigger refresh on registry version resolves
            setLogTrigger(prev => prev + 1);
          }
        );
        newPkgStatuses[repo.path] = depStatuses;
      })
    );

    setGitStatuses(newGitStatuses);
    setPkgStatuses(newPkgStatuses);
  };

  useEffect(() => {
    doScanAndRefresh();
    // Poll Git Status every 7 seconds
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

  // Keep script index bounded when repository changes
  useEffect(() => {
    setSelectedScriptIdx(0);
  }, [selectedRepoIdx]);

  // 3. User Input Handler (Keybinds)
  useInput((input, key) => {
    // Quit
    if (input === 'q' || (key.ctrl && input === 'c')) {
      taskRunner.killAll();
      exit();
      return;
    }

    // Switch Pane
    if (key.tab) {
      setActivePane(prev => (prev === 'repos' ? 'details' : 'repos'));
      return;
    }

    // Toggle logs panel
    if (input === 'l' || input === 'L') {
      setIsLogsExpanded(prev => !prev);
      return;
    }

    // Manual Refresh
    if (input === 'r' || input === 'R') {
      doScanAndRefresh();
      return;
    }

    // Git Pull Selected Repo
    if ((input === 'p' || input === 'P') && selectedRepo && !isPulling) {
      setIsPulling(true);
      setPullStatus(null);
      pullRepository(selectedRepo.path).then((res) => {
        setIsPulling(false);
        setPullStatus({ repoPath: selectedRepo.path, ...res });
        
        // Refresh statuses for the pulled repo
        getGitStatus(selectedRepo.path).then((gitInfo) => {
          setGitStatuses(prev => ({ ...prev, [selectedRepo.path]: gitInfo }));
        });

        // Clear notification after 4s
        setTimeout(() => {
          setPullStatus(null);
        }, 4000);
      });
      return;
    }

    // Navigation (Up / Down)
    if (key.upArrow) {
      if (activePane === 'repos') {
        setSelectedRepoIdx(prev => (prev > 0 ? prev - 1 : repos.length - 1));
      } else {
        setSelectedScriptIdx(prev => (prev > 0 ? prev - 1 : availableScripts.length - 1));
      }
      return;
    }

    if (key.downArrow) {
      if (activePane === 'repos') {
        setSelectedRepoIdx(prev => (prev < repos.length - 1 ? prev + 1 : 0));
      } else {
        setSelectedScriptIdx(prev => (prev < availableScripts.length - 1 ? prev + 1 : 0));
      }
      return;
    }

    // Toggle NPM script execution
    if (key.return || input === ' ') {
      if (activePane === 'details' && selectedRepo && selectedScript) {
        const currentStatus = taskRunner.getTaskStatus(selectedRepo.path, selectedScript);
        if (currentStatus === 'running') {
          taskRunner.stopTask(selectedRepo.path, selectedScript);
        } else {
          taskRunner.startTask(selectedRepo.name, selectedRepo.path, selectedScript);
        }
      }
      return;
    }
  });

  if (scanning && repos.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="cyan" bold>⚡ Gityard Workspace Manager</Text>
        <Text dimColor>Scanning workspace directories...</Text>
      </Box>
    );
  }

  if (repos.length === 0) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor="red">
        <Text color="red" bold>🔴 No Git Repositories Found</Text>
        <Text>Gityard scans immediate subdirectories of the current path for `.git` folders.</Text>
        <Text dimColor>Path: {initialWorkspacePath}</Text>
        <Box marginY={1}>
          <Text color="yellow">Press [Q] to exit.</Text>
        </Box>
      </Box>
    );
  }

  // Check if any task is running in a given repo
  const isAnyTaskRunningInRepo = (repoPath: string, scriptsList: string[]): boolean => {
    return scriptsList.some(s => taskRunner.getTaskStatus(repoPath, s) === 'running');
  };

  return (
    <Box flexDirection="column" width="100%" padding={1}>
      {/* App Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>⚡ Gityard Workspace Manager</Text><Text dimColor>{repos.length} Repositories found | {initialWorkspacePath}</Text>
      </Box>

      {/* Main Workspace: Left Grid & Right Panel */}
      <Box flexDirection="row" height={Math.max(6, isLogsExpanded ? terminalRows - 16 : terminalRows - 8)}>
        {/* Left Pane - Repositories */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={activePane === 'repos' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Box marginBottom={1}>
            <Text bold color={activePane === 'repos' ? 'cyan' : 'white'}>
              📂 WORKSPACE REPOSITORIES
            </Text>
          </Box>

          {repos.map((repo, idx) => {
            const isSelected = idx === selectedRepoIdx;
            const status = gitStatuses[repo.path];
            const repoPkgInfo = pkgConfigs.find(p => p.repoPath === repo.path);
            const scriptsList = repoPkgInfo ? Object.keys(repoPkgInfo.scripts) : [];
            const hasTaskActive = isAnyTaskRunningInRepo(repo.path, scriptsList);

            // Icon statuses
            let statusIcon = '🟢';
            let statusLabel = 'Clean';
            
            if (status) {
              if (status.conflictedCount > 0) {
                statusIcon = '🔴';
                statusLabel = 'Conflict';
              } else if (status.uncommittedCount > 0 || status.untrackedCount > 0) {
                statusIcon = '🟡';
                statusLabel = `⚡ +${status.uncommittedCount}/${status.untrackedCount}`;
              } else if (status.behind > 0) {
                statusIcon = '🟡';
                statusLabel = `Pending Pull`;
              }
            }

            const prefix = isSelected ? '> ' : '  ';
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
                      {statusIcon} {repo.name}
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
                    {hasTaskActive && <Text color="green">🚀 </Text>}
                    <Text color={statusIcon === '🟢' ? 'green' : 'yellow'} dimColor={!isSelected}>
                      {statusLabel}
                    </Text>
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Right Pane - Repository Details & Script Selection */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="round"
          borderColor={activePane === 'details' ? 'cyan' : 'gray'}
          paddingX={1}
        >
          {selectedRepo ? (
            <Box flexDirection="column" height="100%">
              {/* Repo Details Header */}
              <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false} borderColor="gray" paddingBottom={1} marginBottom={1} flexDirection="column">
                <Text bold color="yellow">📦 {selectedRepo.name.toUpperCase()}</Text>{gitStatuses[selectedRepo.path] && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Branch: {gitStatuses[selectedRepo.path].branch}</Text>
                    <Text dimColor>
                      Sync Status: Ahead {gitStatuses[selectedRepo.path].ahead} | Behind {gitStatuses[selectedRepo.path].behind}
                    </Text>
                  </Box>
                )}
              </Box>

              {/* NPM Script Selection */}
              {availableScripts.length > 0 ? (
                <Box flexDirection="column" marginBottom={1}>
                  <Text bold color={activePane === 'details' ? 'cyan' : 'white'}>
                    🏃♂️ NPM Scripts (Use Return/Space to Toggle):
                  </Text>{availableScripts.map((scriptName, idx) => {
                    const isSelected = idx === selectedScriptIdx;
                    const isScriptFocused = isSelected && activePane === 'details';
                    const runStatus = taskRunner.getTaskStatus(selectedRepo.path, scriptName);
                    
                    let statusText = '[Stopped]';
                    let statusColor = 'gray';
                    if (runStatus === 'running') {
                      statusText = '[🚀 Running]';
                      statusColor = 'green';
                    } else if (runStatus === 'failed') {
                      statusText = '[🔴 Failed]';
                      statusColor = 'red';
                    } else if (runStatus === 'success') {
                      statusText = '[🟢 Completed]';
                      statusColor = 'green';
                    }

                    return (
                      <Box key={scriptName} justifyContent="space-between">
                        <Text color={isScriptFocused ? 'cyan' : isSelected ? 'white' : 'gray'} bold={isSelected}>
                          {isSelected ? ' > ' : '   '}
                          {scriptName}: <Text dimColor>{truncate(selectedRepoPkg?.scripts[scriptName] || '', 24)}</Text>
                        </Text><Text color={statusColor}>{statusText}</Text>
                      </Box>
                    );
                  })}
                </Box>
              ) : (
                <Box marginBottom={1}>
                  <Text dimColor>No NPM scripts found (no package.json or scripts block).</Text>
                </Box>
              )}

              {/* Package dependencies / Drift */}
              <Box flexDirection="column">
                <Text bold>📦 Dependency Status / Drift:</Text>{pkgStatuses[selectedRepo.path] && pkgStatuses[selectedRepo.path].length > 0 ? (
                  pkgStatuses[selectedRepo.path]
                    .filter(status => status.hasDrift || status.isOutdated)
                    .slice(0, 3) // show up to 3 warnings to fit screen
                    .map((status) => {
                      let driftDetail = '';
                      if (status.hasDrift && status.driftVersions) {
                        const otherRepos = Object.entries(status.driftVersions)
                          .filter(([repo]) => repo !== selectedRepo.name)
                          .map(([repo, ver]) => `${repo}: ${ver}`)
                          .join(', ');
                        driftDetail = ` (drift: ${otherRepos})`;
                      }

                      return (
                        <Text key={status.packageName} color="yellow" dimColor>
                          ⚠️ {status.packageName}: {status.currentVersion}
                          {status.isOutdated && ` -> ${status.latestVersion}`}
                          {driftDetail}
                        </Text>
                      );
                    })
                ) : (
                  <Text dimColor>All packages up-to-date & synchronized</Text>
                )}
                {pkgStatuses[selectedRepo.path] && 
                 pkgStatuses[selectedRepo.path].filter(status => status.hasDrift || status.isOutdated).length > 3 && (
                  <Text dimColor>
                    ... and {pkgStatuses[selectedRepo.path].filter(status => status.hasDrift || status.isOutdated).length - 3} more issues
                  </Text>
                )}
              </Box>
            </Box>
          ) : (
            <Text dimColor>No repository selected</Text>
          )}
        </Box>
      </Box>

      {/* Action status notification */}
      {isPulling && (
        <Box marginY={1}>
          <Text color="cyan">🔄 Pulling updates from remote for {selectedRepo?.name}...</Text>
        </Box>
      )}
      {!isPulling && pullStatus && pullStatus.repoPath === selectedRepo?.path && (
        <Box marginY={1}>
          <Text color={pullStatus.success ? 'green' : 'red'}>
            {pullStatus.success ? '🟢' : '🔴'} {pullStatus.message}
          </Text>
        </Box>
      )}

      {/* Bottom Panel - Active Log Viewer */}
      {isLogsExpanded && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          height={5}
        >
          <Box justifyContent="space-between">
            <Text bold color="yellow">
              📋 LOGS: {selectedRepo?.name} {selectedScript ? `> ${selectedScript}` : ''}
            </Text><Text dimColor>[Press L to Collapse]</Text>
          </Box>
          
          {selectedRepo && selectedScript ? (
            <Box flexDirection="column" marginTop={0}>
              {taskRunner.getLogs(selectedRepo.path, selectedScript).slice(-2).map((logLine, index) => (
                <Text key={index} wrap="truncate" dimColor>
                  {logLine}
                </Text>
              ))}
              {taskRunner.getLogs(selectedRepo.path, selectedScript).length === 0 && (
                <Text dimColor>No logs. Highlight a script in details and hit Space to run it.</Text>
              )}
            </Box>
          ) : (
            <Text dimColor>Select a script to view logs.</Text>
          )}
        </Box>
      )}

      {/* Bottom Status / Help Bar */}
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" marginTop={1} paddingY={0}>
        <Text>
          <Text dimColor>Hotkeys: </Text>
          <Text color="cyan">[Tab]</Text><Text dimColor> Switch Pane | </Text>
          <Text color="cyan">[Arrows]</Text><Text dimColor> Navigate | </Text>
          <Text color="cyan">[Space/Enter]</Text><Text dimColor> Run Script | </Text>
          <Text color="cyan">[P]</Text><Text dimColor> Git Pull | </Text>
          <Text color="cyan">[R]</Text><Text dimColor> Refresh | </Text>
          <Text color="cyan">[L]</Text><Text dimColor> Toggle Logs | </Text>
          <Text color="cyan">[Q]</Text><Text dimColor> Quit</Text>
        </Text>
      </Box>
    </Box>
  );
}
