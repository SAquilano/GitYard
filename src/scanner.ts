import fs from 'node:fs/promises';
import path from 'node:path';

export interface ScannedRepo {
  name: string;
  path: string;
  hasPackageJson: boolean;
}

/**
 * Checks if a directory contains a .git folder or file (supporting git-worktrees/submodules).
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(dirPath, '.git');
    const stat = await fs.stat(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Checks if a directory contains a package.json file.
 */
async function hasPackageJsonFile(dirPath: string): Promise<boolean> {
  try {
    const packageJsonPath = path.join(dirPath, 'package.json');
    const stat = await fs.stat(packageJsonPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Scans the workspacePath. If the path itself is a Git repository, returns it.
 * Otherwise, scans all immediate subdirectories.
 */
export async function scanWorkspace(workspacePath: string): Promise<ScannedRepo[]> {
  const absolutePath = path.resolve(workspacePath);
  
  // 1. Fallback check: Is the root directory itself a git repo?
  if (await isGitRepo(absolutePath)) {
    return [
      {
        name: path.basename(absolutePath),
        path: absolutePath,
        hasPackageJson: await hasPackageJsonFile(absolutePath),
      },
    ];
  }

  // 2. Scan immediate subdirectories
  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const checkPromises = entries.map(async (entry) => {
      if (!entry.isDirectory()) return null;
      
      const repoPath = path.join(absolutePath, entry.name);
      const isGit = await isGitRepo(repoPath);
      
      if (isGit) {
        return {
          name: entry.name,
          path: repoPath,
          hasPackageJson: await hasPackageJsonFile(repoPath),
        };
      }
      return null;
    });

    const results = await Promise.all(checkPromises);
    return results.filter((repo): repo is ScannedRepo => repo !== null);
  } catch (error) {
    console.error('Error scanning workspace:', error);
    return [];
  }
}
