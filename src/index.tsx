#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { intro, select, text, outro, isCancel } from '@clack/prompts';
import { AppTUI } from './tui.js';
import { scanWorkspace } from './scanner.js';
import path from 'node:path';
import fs from 'node:fs/promises';

// Prevent crash in non-TTY environments (e.g. CI, pipes, subshells)
if (!process.stdin.setRawMode) {
  process.stdin.setRawMode = function() { return this; };
}
(process.stdin as any).isRawModeSupported = true;
(process.stdin as any).isTTY = true;

async function main() {
  let targetPath = process.cwd();
  
  if (process.argv[2]) {
    targetPath = path.resolve(process.argv[2]);
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        console.error(`Error: ${process.argv[2]} is not a directory.`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: Could not access directory at ${process.argv[2]}.`);
      process.exit(1);
    }
  }
  
  // Try scanning the current directory first
  let repos = await scanWorkspace(targetPath);
  
  if (repos.length === 0) {
    // Run Clack interactive prompts if no repos found in CWD
    intro('⚡ Gityard Workspace Manager Setup');
    
    const choice = await select({
      message: 'No Git repositories found in the current directory. What would you like to do?',
      options: [
        { value: 'custom', label: 'Scan a custom directory path' },
        { value: 'exit', label: 'Exit Gityard' },
      ],
    });
    
    if (isCancel(choice) || choice === 'exit') {
      outro('Exited setup.');
      process.exit(0);
    }
    
    if (choice === 'custom') {
      const customPathInput = await text({
        message: 'Enter the absolute or relative path of the workspace:',
        placeholder: 'e.g. ../my-repositories',
        validate(value) {
          if (!value.trim()) return 'Path cannot be empty';
          return;
        },
      });
      
      if (isCancel(customPathInput)) {
        outro('Exited setup.');
        process.exit(0);
      }
      
      const resolved = path.resolve(customPathInput);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          outro(`Error: ${customPathInput} is not a directory.`);
          process.exit(1);
        }
      } catch {
        outro(`Error: Could not access directory at ${customPathInput}.`);
        process.exit(1);
      }
      
      targetPath = resolved;
      repos = await scanWorkspace(targetPath);
      
      if (repos.length === 0) {
        outro(`Error: No Git repositories found in directory: ${targetPath}`);
        process.exit(1);
      }
    }
  }

  // Start Ink TUI
  render(<AppTUI initialWorkspacePath={targetPath} />);
}

main().catch((err) => {
  console.error('Unhandled error in Gityard CLI:', err);
  process.exit(1);
});
