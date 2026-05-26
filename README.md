# ◈ GitYard

A modern terminal user interface (TUI) for managing multiple Git repositories and monorepos in a single workspace. Track branch synchronization, detect dependency drifts, run NPM scripts, and upgrade packages directly from your terminal.

## Features

- **Sleek TUI Layout:** Minimalist design with real-time status indicators (green, yellow, and red LED-style indicators).
- **Workspace Scanning:** Auto-detects all Git repositories in any directory.
- **Git Sync Monitor:** Shows branch names, uncommitted files, conflicts, and ahead/behind commit counts.
- **Universal Pull:** Pull updates across all workspace repositories sequentially with a custom animated progress bar.
- **NPM Task Runner:** Lists and runs npm scripts (like dev servers, compilers, or test suites) in background processes with on-demand log streaming.
- **Dependency Drift Detection:** Highlights packages that have version mismatch (drift) or are outdated compared to the NPM Registry.
- **Interactive Dependency Upgrader:** Cycle through outdated dependencies and upgrade them individually with a single keypress.
- **Flicker-Free Render Engine:** Smart debounced updates and static-height boxes for a perfectly stable terminal display.

## Installation

Install GitYard globally on your system:

```bash
npm install -g .
```

Or run it directly using `npx` inside your workspace directory:

```bash
npx gityard .
```

## Quick Start

Run GitYard in the directory containing your project folders:

```bash
gityard .
```

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Tab` | Switch focus between panels (Repositories, NPM Scripts, Dependencies) |
| `▲ / ▼` | Navigate lists within the active panel |
| `Space` / `Enter` | Run/stop selected script OR upgrade selected dependency |
| `P` | Git Pull selected repository |
| `A` | Git Pull all repositories (Universal Pull) |
| `R` | Trigger manual workspace refresh |
| `L` | Toggle bottom logs panel |
| `Q` | Quit GitYard (kills all active background processes safely) |
