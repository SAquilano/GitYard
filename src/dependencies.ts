import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface PackageDependencies {
  repoName: string;
  repoPath: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

export interface DependencyDrift {
  packageName: string;
  versions: Record<string, string>; // repoName -> version spec
  hasDrift: boolean;
}

export interface PackageStatus {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  isOutdated: boolean;
  hasDrift: boolean;
  driftVersions?: Record<string, string>;
}

const registryCache = new Map<string, string>();

/**
 * Fetches the latest version of a package from the NPM registry.
 * Uses a timeout of 1.2 seconds and returns null on failure or offline.
 */
export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  if (registryCache.has(packageName)) {
    return registryCache.get(packageName) || null;
  }

  // Basic check for valid package name
  if (!packageName || packageName.startsWith('@types/')) {
    return null; // Skip @types to keep it fast
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200);

  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { version?: string };
    if (data.version) {
      registryCache.set(packageName, data.version);
      return data.version;
    }
  } catch {
    // Fail silently (offline or invalid package)
  } finally {
    clearTimeout(timeoutId);
  }

  return null;
}

/**
 * Asynchronously loads package.json information for all scanned repositories.
 */
export async function loadWorkspacePackages(
  repos: { name: string; path: string; hasPackageJson: boolean }[]
): Promise<PackageDependencies[]> {
  const promises = repos.map(async (repo) => {
    if (!repo.hasPackageJson) return null;

    try {
      const packageJsonPath = path.join(repo.path, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf8');
      const data = JSON.parse(content);

      return {
        repoName: repo.name,
        repoPath: repo.path,
        dependencies: data.dependencies || {},
        devDependencies: data.devDependencies || {},
        scripts: data.scripts || {},
      };
    } catch {
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter((p): p is PackageDependencies => p !== null);
}

/**
 * Calculates drift across the workspace.
 * A package has drift if it exists in multiple repositories with different version specs.
 */
export function calculateDrifts(workspacePackages: PackageDependencies[]): Map<string, DependencyDrift> {
  const allPackages = new Map<string, Record<string, string>>();

  for (const pkgInfo of workspacePackages) {
    const combined = { ...pkgInfo.dependencies, ...pkgInfo.devDependencies };
    for (const [name, version] of Object.entries(combined)) {
      if (!allPackages.has(name)) {
        allPackages.set(name, {});
      }
      allPackages.get(name)![pkgInfo.repoName] = version;
    }
  }

  const drifts = new Map<string, DependencyDrift>();
  for (const [packageName, versions] of allPackages.entries()) {
    const uniqueVersions = new Set(Object.values(versions));
    const hasDrift = uniqueVersions.size > 1;

    drifts.set(packageName, {
      packageName,
      versions,
      hasDrift,
    });
  }

  return drifts;
}

/**
 * Generates status indicators for a specific repository's dependencies.
 */
export async function getRepoDependencyStatuses(
  repoName: string,
  workspacePackages: PackageDependencies[],
  drifts: Map<string, DependencyDrift>,
  onUpdate?: () => void
): Promise<PackageStatus[]> {
  const repoPkg = workspacePackages.find(p => p.repoName === repoName);
  if (!repoPkg) return [];

  const combined = { ...repoPkg.dependencies, ...repoPkg.devDependencies };
  const statuses: PackageStatus[] = [];

  const packagesToCheck = Object.keys(combined);

  packagesToCheck.forEach((packageName) => {
    const currentVersion = combined[packageName];
    const drift = drifts.get(packageName);
    const hasDrift = drift ? drift.hasDrift : false;
    const driftVersions = hasDrift ? drift?.versions : undefined;

    const status: PackageStatus = {
      packageName,
      currentVersion,
      hasDrift,
      driftVersions,
      isOutdated: false,
    };

    statuses.push(status);

    // Fetch latest version in the background
    fetchLatestVersion(packageName).then((latest) => {
      if (latest) {
        status.latestVersion = latest;
        
        // Simple outdated check
        const cleanCurrent = currentVersion.replace(/[\^~>=<]/g, '').trim();
        if (cleanCurrent && latest !== cleanCurrent && !currentVersion.includes(latest)) {
          status.isOutdated = true;
        }
        if (onUpdate) onUpdate();
      }
    });
  });

  return statuses;
}

export async function installDependency(
  repoPath: string,
  packageName: string,
  version: string
): Promise<{ success: boolean; message: string }> {
  try {
    await execAsync(`npm install ${packageName}@${version}`, { cwd: repoPath });
    return {
      success: true,
      message: `Updated ${packageName} to ${version}`,
    };
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to update ${packageName}: ${error.message || error}`,
    };
  }
}
