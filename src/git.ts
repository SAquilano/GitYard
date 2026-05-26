import { simpleGit, SimpleGit } from 'simple-git';

export interface RepoGitStatus {
  branch: string;
  ahead: number;
  behind: number;
  uncommittedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  isClean: boolean;
  changedFiles: { path: string; workingDir: string; index: string }[];
}

/**
 * Parallel-fetch Git status details for a repository.
 */
export async function getGitStatus(repoPath: string): Promise<RepoGitStatus> {
  const git: SimpleGit = simpleGit(repoPath);
  try {
    const status = await git.status();
    
    // Group files
    // workingDir = '?' and index = '?' means untracked.
    const untracked = status.files.filter(f => f.working_dir === '?' && f.index === '?');
    const uncommitted = status.files.filter(f => !(f.working_dir === '?' && f.index === '?'));
    
    return {
      branch: status.current || 'DETACHED',
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      uncommittedCount: uncommitted.length,
      untrackedCount: untracked.length,
      conflictedCount: status.conflicted.length,
      isClean: status.isClean(),
      changedFiles: status.files.map(f => ({
        path: f.path,
        workingDir: f.working_dir,
        index: f.index,
      })),
    };
  } catch (error) {
    return {
      branch: 'UNKNOWN',
      ahead: 0,
      behind: 0,
      uncommittedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      isClean: true,
      changedFiles: [],
    };
  }
}

/**
 * Pull updates from the remote repository tracking branch.
 */
export async function pullRepository(repoPath: string): Promise<{ success: boolean; message: string }> {
  const git: SimpleGit = simpleGit(repoPath);
  try {
    await git.pull();
    return {
      success: true,
      message: 'Pull completed successfully',
    };
  } catch (error: any) {
    return {
      success: false,
      message: error?.message || 'Failed to pull',
    };
  }
}
