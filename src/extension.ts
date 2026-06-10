import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

interface ThemeMap {
	[pathOrPrefix: string]: string;
}

const CONFIG_SECTION = 'workspaceTheme';

function getMap(): ThemeMap {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<ThemeMap>('themes') ?? {};
}

/** The folder this window is rooted at. We target single-folder windows (opened via ?folder=...). */
function currentFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

const stripTrailingSlash = (p: string): string => p.replace(/\/+$/, '');

/** Exact match first, otherwise the longest key that is a path-prefix of the folder. */
function matchTheme(folderPath: string, map: ThemeMap): string | undefined {
	const target = stripTrailingSlash(folderPath);
	let best: string | undefined;
	let bestLen = -1;
	for (const key of Object.keys(map)) {
		const k = stripTrailingSlash(key);
		const isMatch = target === k || target.startsWith(k + '/');
		if (isMatch && k.length > bestLen) {
			bestLen = k.length;
			best = map[key];
		}
	}
	return best;
}

/** Write the theme into the folder's workspace settings (per-window scope), if not already set. */
async function applyTheme(folder: vscode.WorkspaceFolder, theme: string): Promise<void> {
	const wb = vscode.workspace.getConfiguration('workbench', folder.uri);
	const info = wb.inspect<string>('colorTheme');
	if (info?.workspaceValue === theme) {
		return; // already set for this workspace, avoid file churn
	}
	await wb.update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
	maybeGitExclude(folder.uri.fsPath);
}

/** Keep the personal theme out of the shared repo by adding it to .git/info/exclude (local, untracked). */
function maybeGitExclude(folderPath: string): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	if (!cfg.get<boolean>('autoGitExclude', true)) {
		return;
	}
	let root: string;
	try {
		root = execSync('git rev-parse --show-toplevel', { cwd: folderPath })
			.toString()
			.trim();
	} catch {
		return; // not a git repo (or git unavailable)
	}
	if (!root) {
		return;
	}
	try {
		// exit 0 means already ignored (by any mechanism) - nothing to do
		execSync('git check-ignore -q .vscode/settings.json', { cwd: folderPath });
		return;
	} catch {
		// not ignored yet - fall through and add it
	}
	const excludeFile = path.join(root, '.git', 'info', 'exclude');
	let content = '';
	try {
		content = fs.readFileSync(excludeFile, 'utf8');
	} catch {
		// file may not exist yet
	}
	const alreadyListed = content.split(/\r?\n/).some((l) => l.trim() === '.vscode/settings.json');
	if (!alreadyListed) {
		const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
		fs.appendFileSync(excludeFile, `${prefix}.vscode/settings.json\n`);
	}
}

async function applyForCurrentWindow(): Promise<void> {
	const folder = currentFolder();
	if (!folder) {
		return;
	}
	const theme = matchTheme(folder.uri.fsPath, getMap());
	if (theme) {
		await applyTheme(folder, theme);
	}
}

/**
 * Run the built-in theme picker (native live preview) and RELIABLY return the theme the user
 * accepted, or undefined on cancel / no change. We capture the value from the
 * onDidChangeConfiguration event (which fires AFTER the config is updated) instead of reading
 * the config immediately after the command resolves, because that immediate read is racy: the
 * picker's write may not have propagated yet, making it look like nothing changed.
 */
async function runNativePicker(folderUri: vscode.Uri): Promise<string | undefined> {
	const read = () => vscode.workspace.getConfiguration('workbench', folderUri).get<string>('colorTheme');
	const prev = read();
	let last: string | undefined;
	const sub = vscode.workspace.onDidChangeConfiguration((e) => {
		// In-memory preview (arrowing) does NOT write config; only the accepted theme does.
		if (e.affectsConfiguration('workbench.colorTheme')) {
			last = read();
		}
	});
	try {
		await vscode.commands.executeCommand('workbench.action.selectTheme');
		await new Promise((r) => setTimeout(r, 300)); // let the accept-write propagate
	} finally {
		sub.dispose();
	}
	const finalTheme = last ?? read();
	return finalTheme && finalTheme !== prev ? finalTheme : undefined;
}

interface ColorThemeInspect {
	globalValue?: string;
	workspaceValue?: string;
}

/** Put the current window's color theme back to a snapshot, touching only the scopes that changed. */
async function restoreTheme(
	folderUri: vscode.Uri,
	prevWorkspace: string | undefined,
	prevGlobal: string | undefined,
	after: ColorThemeInspect | undefined
): Promise<void> {
	const wb = vscode.workspace.getConfiguration('workbench', folderUri);
	if (after?.workspaceValue !== prevWorkspace) {
		await wb.update('colorTheme', prevWorkspace, vscode.ConfigurationTarget.Workspace);
	}
	if (after?.globalValue !== prevGlobal) {
		await wb.update('colorTheme', prevGlobal, vscode.ConfigurationTarget.Global);
	}
}

/**
 * Pick a theme for any mapped workspace using the native picker for live preview.
 * The preview plays on the CURRENT window; the chosen theme is saved to the TARGET
 * workspace's map entry, and the current window is restored to how it was.
 */
async function pickThemeForWorkspace(targetPathArg?: string): Promise<void> {
	const current = currentFolder();
	if (!current) {
		vscode.window.showWarningMessage('Workspace Theme: open a folder first (the preview plays in this window).');
		return;
	}
	const currentPath = current.uri.fsPath;

	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const map: ThemeMap = { ...(cfg.get<ThemeMap>('themes') ?? {}) };

	// Resolve the target workspace: an explicit arg (e.g. from the settings.json CodeLens),
	// otherwise a chooser that includes the current window and every mapped folder.
	let targetPath: string;
	if (typeof targetPathArg === 'string' && targetPathArg.length > 0) {
		targetPath = stripTrailingSlash(targetPathArg);
	} else {
		const items: vscode.QuickPickItem[] = [];
		if (map[currentPath] === undefined) {
			items.push({ label: currentPath, description: 'this window' });
		}
		for (const key of Object.keys(map)) {
			items.push({
				label: key,
				description: (key === currentPath ? 'this window - ' : '') + map[key],
			});
		}
		const ENTER_PATH = '$(add) Enter a folder path...';
		items.push({ label: ENTER_PATH });

		const target = await vscode.window.showQuickPick(items, {
			placeHolder: 'Which workspace folder should receive the theme?',
		});
		if (!target) {
			return;
		}
		if (target.label === ENTER_PATH) {
			const input = await vscode.window.showInputBox({
				prompt: 'Absolute folder path to map to a theme',
				value: currentPath,
			});
			if (!input) {
				return;
			}
			targetPath = stripTrailingSlash(input.trim());
		} else {
			targetPath = target.label;
		}
	}
	const targetingCurrent = targetPath === currentPath;

	// Snapshot the current window so we can restore it after previewing on it.
	const before = vscode.workspace.getConfiguration('workbench', current.uri).inspect<string>('colorTheme');
	const prevGlobal = before?.globalValue;
	const prevWorkspace = before?.workspaceValue;

	// Native picker previews live on THIS window; capture the accepted theme reliably.
	const chosen = await runNativePicker(current.uri);

	// Config is settled now (runNativePicker waited), so this inspect is reliable.
	const after = vscode.workspace.getConfiguration('workbench', current.uri).inspect<string>('colorTheme');

	if (!chosen) {
		// Cancelled / same theme - leave the current window exactly as it was.
		await restoreTheme(current.uri, prevWorkspace, prevGlobal, after);
		return;
	}

	if (targetingCurrent) {
		// Keep the chosen theme on this window (workspace scope), undo any user-settings change.
		const wb = vscode.workspace.getConfiguration('workbench', current.uri);
		if (after?.workspaceValue !== chosen) {
			await wb.update('colorTheme', chosen, vscode.ConfigurationTarget.Workspace);
		}
		if (after?.globalValue !== prevGlobal) {
			await wb.update('colorTheme', prevGlobal, vscode.ConfigurationTarget.Global);
		}
		maybeGitExclude(currentPath);
	} else {
		// Targeting another workspace: snap this window back to its own theme.
		await restoreTheme(current.uri, prevWorkspace, prevGlobal, after);
	}

	// Save to the target's map entry. Its own window (if open) reacts to the config change;
	// otherwise the theme is applied the next time that folder is opened.
	map[targetPath] = chosen;
	await cfg.update('themes', map, vscode.ConfigurationTarget.Global);

	vscode.window.showInformationMessage(`Workspace Theme: ${targetPath} -> ${chosen}`);
}

async function useGlobalTheme(): Promise<void> {
	const folder = currentFolder();
	if (!folder) {
		vscode.window.showWarningMessage('Workspace Theme: open a folder first.');
		return;
	}

	const wb = vscode.workspace.getConfiguration('workbench', folder.uri);
	const insp = wb.inspect<string>('colorTheme');
	const hadWorkspaceOverride = insp?.workspaceValue !== undefined;

	// Remove the workspace-scoped override so the global theme takes over again.
	if (hadWorkspaceOverride) {
		await wb.update('colorTheme', undefined, vscode.ConfigurationTarget.Workspace);
	}

	// Drop the entry from the central map so it is not re-applied on the next open.
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const map: ThemeMap = { ...(cfg.get<ThemeMap>('themes') ?? {}) };
	const hadMapping = map[folder.uri.fsPath] !== undefined;
	if (hadMapping) {
		delete map[folder.uri.fsPath];
		await cfg.update('themes', map, vscode.ConfigurationTarget.Global);
	}

	if (!hadWorkspaceOverride && !hadMapping) {
		vscode.window.showInformationMessage(`Workspace Theme: ${folder.name} already follows the global theme.`);
		return;
	}

	const globalTheme = insp?.globalValue ?? 'the default';
	vscode.window.showInformationMessage(`Workspace Theme: ${folder.name} now follows the global theme (${globalTheme}).`);
}

/** Puts a "▶ Set theme" action above each entry of the themes map in settings.json. */
class ThemesCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		try {
			return this.computeLenses(document);
		} catch {
			return []; // never let a parsing hiccup break the editor
		}
	}

	private computeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		const keyIdx = text.indexOf('"workspaceTheme.themes"');
		if (keyIdx < 0) {
			return [];
		}
		const braceOpen = text.indexOf('{', keyIdx);
		if (braceOpen < 0) {
			return [];
		}
		// Find the matching close brace for the map object.
		let depth = 0;
		let end = text.length;
		for (let i = braceOpen; i < text.length; i++) {
			if (text[i] === '{') {
				depth++;
			} else if (text[i] === '}') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}

		const lenses: vscode.CodeLens[] = [];
		const entryRe = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
		const block = text.substring(braceOpen, end);
		let m: RegExpExecArray | null;
		while ((m = entryRe.exec(block)) !== null) {
			const path = m[1].replace(/\\(.)/g, '$1'); // unescape JSON string escapes
			const pos = document.positionAt(braceOpen + m.index);
			lenses.push(
				new vscode.CodeLens(new vscode.Range(pos.line, 0, pos.line, 0), {
					title: '▶ Set theme',
					command: 'workspaceTheme.pickThemeForWorkspace',
					arguments: [path],
				})
			);
		}
		return lenses;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	void applyForCurrentWindow();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${CONFIG_SECTION}.themes`)) {
				void applyForCurrentWindow();
			}
		}),
		vscode.commands.registerCommand('workspaceTheme.pickThemeForWorkspace', (targetPath?: string) =>
			pickThemeForWorkspace(targetPath)
		),
		vscode.commands.registerCommand('workspaceTheme.useGlobalTheme', useGlobalTheme),
		vscode.commands.registerCommand('workspaceTheme.editMapping', () =>
			vscode.commands.executeCommand('workbench.action.openSettingsJson')
		),
		vscode.languages.registerCodeLensProvider(
			[
				{ language: 'jsonc', pattern: '**/settings.json' },
				{ language: 'json', pattern: '**/settings.json' },
				{ scheme: 'vscode-userdata' }
			],
			new ThemesCodeLensProvider()
		)
	);
}

export function deactivate(): void {}
