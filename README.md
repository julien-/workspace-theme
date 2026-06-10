# Workspace Theme

Apply a **full color theme per workspace folder**, from a single map you keep in your user settings.

![CI](https://github.com/julien-/workspace-theme/actions/workflows/ci.yml/badge.svg)
![Open VSX](https://img.shields.io/open-vsx/v/julien-/workspace-theme?label=Open%20VSX)
![VS Code](https://img.shields.io/badge/VS%20Code-1.70%2B-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![License](https://img.shields.io/badge/license-MIT-green)

VS Code's theme picker only writes one global theme. This extension lets each folder have its **own** complete `workbench.colorTheme` - editor background, syntax colors, everything: open one project and you get one theme, open another and you get a different one. Each window keeps its own theme, and no two windows fight over it. It pairs nicely with code-server's `?folder=` URLs, but works anywhere VS Code does.

## How it works

You keep one map in your **user** settings:

```json
"workspaceTheme.themes": {
  "/home/you/project-a": "Mint Green",
  "/home/you/project-b": "Tomorrow Night Blue"
}
```

When you open a folder, the extension finds the matching entry - exact path, or the **longest path-prefix** (so `/home/you` can be a default that subfolders override) - and writes `workbench.colorTheme` into that folder's `.vscode/settings.json`. That is workspace scope, so it is resolved per window.

The value is the theme label exactly as it appears in the theme picker (e.g. `Mint Green`).

## Commands

| Command | What it does |
|---------|--------------|
| **Workspace Theme: Set workspace theme** | Pick a target (the current window, any mapped folder, or a new path), then the built-in theme picker opens with full live preview on the current window. Your choice is saved to the target's map entry; if the target was a different folder, the current window is restored to its own theme. |
| **Workspace Theme: Delete workspace theme** | Reverts the current folder to the global theme: removes its `workbench.colorTheme` and its entry from the map. |
| **Workspace Theme: Edit mapping** | Opens your `settings.json` at the map. |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `workspaceTheme.themes` | `{}` | Map of folder path (or path prefix) to theme label. Easiest filled with **Set workspace theme** (or the CodeLens) rather than by hand. |
| `workspaceTheme.autoGitExclude` | `true` | The theme is written to `.vscode/settings.json` inside the project. Since that is usually a shared git repo, this adds the file to `.git/info/exclude` (a local, untracked ignore - it never touches the shared `.gitignore`) so your personal theme is not committed. Set to `false` to let it be committed. |

## settings.json CodeLens

Open your `settings.json` (the **Edit mapping** command) and a `▶ Set theme` action appears above each entry of the map:

```
▶ Set theme
"/home/you/project-a": "Mint Green",
▶ Set theme
"/home/you/project-b": "Tomorrow Night Blue",
```

Click it to run **Set workspace theme** pre-targeted to that line's folder (the chooser is skipped). It is the per-row action the Settings GUI cannot offer, because an `object` setting renders as a single tile with no per-line controls.

## Install

**From the Extensions panel** (code-server / VSCodium, which use [Open VSX](https://open-vsx.org/extension/julien-/workspace-theme)): search for **Workspace Theme** and click Install.

Or grab the `.vsix` from the [latest release](https://github.com/julien-/workspace-theme/releases) (CI builds and attaches it on every `v*` tag), or package it yourself - then install:

```bash
# package locally (optional)
npx @vscode/vsce package

# install
code --install-extension workspace-theme-*.vsix
# or, for code-server:
code-server --install-extension workspace-theme-*.vsix
```

## Notes

A theme can only be made per-window by living in workspace scope, and there is no API to set a theme for "this window only" in memory - so the extension writes the folder's `.vscode/settings.json` (and `autoGitExclude` keeps it out of the repo).

## Develop

```bash
npm install
npm test                  # compile + run the test harness (mocks vscode, drives the compiled build)
npx @vscode/vsce package  # produce a .vsix
```

`scripts/test-harness.js` loads the compiled extension with a mocked `vscode` module and asserts: activation registers the commands and CodeLens provider without throwing; the settings.json CodeLens parses each map entry and points at the pick command; and the pick flow saves to the right target (current vs another folder), restores the current window when targeting another folder, and does nothing on cancel. `test/e2e/` drives the real theme picker in a real code-server via Selenium.

## License

MIT
