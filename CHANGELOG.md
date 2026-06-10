# Changelog

## 1.0.0

First release.

- Apply a full color theme per workspace folder from a single `workspaceTheme.themes` map (path -> theme label), resolved per window with longest-prefix matching.
- **Set workspace theme** - choose a target (current window, any mapped folder, or a new path), pick a theme with the built-in picker's live preview, save it to that folder's map entry.
- **Delete workspace theme** - revert a folder to the global theme.
- **Edit mapping** - open the map in `settings.json`, with a `▶ Set theme` CodeLens above each entry.
- `autoGitExclude` keeps the per-folder `.vscode/settings.json` out of shared repos via `.git/info/exclude`.
