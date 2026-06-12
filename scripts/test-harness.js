// Loads the COMPILED extension with a mocked `vscode` module and exercises the real code paths.
const Module = require('module');
const path = require('path');

const EXT = path.resolve(__dirname, '..', 'out', 'extension.js');

let failures = 0;
function check(name, cond, extra) {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}` + (!cond && extra ? `   [${extra}]` : ''));
	if (!cond) failures++;
}

// ---- recorded side effects ----
const exec = [];
const registered = {};
let codeLensProvider = null;
const messages = [];

// ---- mutable config store ----
const store = {
	wt: { themes: {}, autoGitExclude: false },
	wbGlobal: 'GlobalTheme',
	wbWorkspace: undefined,
};
let currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

function getConfiguration(section) {
	if (section === 'workspaceTheme') {
		return {
			get: (k, def) => (store.wt[k] !== undefined ? store.wt[k] : def),
			update: async (k, v) => { store.wt[k] = v; },
			inspect: (k) => ({ globalValue: store.wt[k] }),
		};
	}
	if (section === 'workbench') {
		return {
			get: () => (store.wbWorkspace !== undefined ? store.wbWorkspace : store.wbGlobal),
			inspect: () => ({ globalValue: store.wbGlobal, workspaceValue: store.wbWorkspace }),
			update: async (k, v, target) => {
				if (target === ConfigurationTarget.Workspace) store.wbWorkspace = v;
				else if (target === ConfigurationTarget.Global) store.wbGlobal = v;
			},
		};
	}
	return { get: (k, def) => def, update: async () => {}, inspect: () => ({}) };
}

const vscodeMock = {
	ConfigurationTarget,
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	Range: class { constructor(a, b, c, d) { this.startLine = a; this.startChar = b; this.endLine = c; this.endChar = d; } },
	CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
	commands: {
		registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; },
		executeCommand: async (cmd, ...args) => {
			exec.push({ cmd, args });
			// Simulate the native picker accepting a theme: it writes colorTheme and fires the config event.
			if (cmd === 'workbench.action.selectTheme' && vscodeMock.__simulatePick) {
				if (store.wbWorkspace !== undefined) store.wbWorkspace = vscodeMock.__simulatePick;
				else store.wbGlobal = vscodeMock.__simulatePick;
				if (vscodeMock.__onConfig) vscodeMock.__onConfig({ affectsConfiguration: (k) => k === 'workbench.colorTheme' });
			}
			return undefined;
		},
	},
	window: {
		showInformationMessage: (m) => { messages.push(['info', m]); return Promise.resolve(undefined); },
		showWarningMessage: (m) => { messages.push(['warn', m]); return Promise.resolve(undefined); },
		showErrorMessage: (m) => { messages.push(['error', m]); return Promise.resolve(undefined); },
		showQuickPick: async () => vscodeMock.__quickPickAnswer,
		showInputBox: async () => vscodeMock.__inputAnswer,
	},
	workspace: {
		get workspaceFolders() { return currentFolders; },
		getConfiguration,
		onDidChangeConfiguration: (fn) => { vscodeMock.__onConfig = fn; return { dispose() {} }; },
	},
	languages: {
		registerCodeLensProvider: (selector, provider) => { codeLensProvider = provider; return { dispose() {} }; },
	},
};

const origLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return vscodeMock;
	return origLoad.apply(this, arguments);
};

const ext = require(EXT);

// ---- Test 1: activation ----
const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
let threw = null;
try { ext.activate(context); } catch (e) { threw = e; }
check('activate() does not throw', threw === null);
check('registers exactly 3 commands', Object.keys(registered).length === 3, JSON.stringify(Object.keys(registered)));
['pickThemeForWorkspace', 'deleteThemeForWorkspace', 'editMapping'].forEach((c) =>
	check(`command workspaceTheme.${c} registered`, !!registered['workspaceTheme.' + c]));
check('removed: useGlobalTheme', !registered['workspaceTheme.useGlobalTheme']);
check('removed: setForThisWorkspace', !registered['workspaceTheme.setForThisWorkspace']);
check('removed: openWorkspaceAndPickTheme', !registered['workspaceTheme.openWorkspaceAndPickTheme']);
check('registers a CodeLens provider', !!codeLensProvider);
check('pushes disposables', context.subscriptions.length >= 5);

// ---- Test 2: CodeLens parsing, now points at pickThemeForWorkspace ----
const settings = `{
  "editor.fontSize": 13,
  "workspaceTheme.themes": {
    "/config/workspace/aaa": "Mint Green",
    "/config/workspace/bbb": "Tomorrow Night Blue"
  },
  "other.object": { "nested": "x" }
}`;
const doc = { getText: () => settings, positionAt: (o) => ({ line: settings.slice(0, o).split('\n').length - 1, character: 0 }) };
const lenses = codeLensProvider.provideCodeLenses(doc);
check('CodeLens: exactly 4 lenses (set + delete per entry)', lenses.length === 4);
check('CodeLens: paths captured as args', lenses[0].command.arguments[0] === '/config/workspace/aaa' && lenses[2].command.arguments[0] === '/config/workspace/bbb');
check('CodeLens: set command -> pickThemeForWorkspace', lenses[0].command.command === 'workspaceTheme.pickThemeForWorkspace');
check('CodeLens: delete command -> deleteThemeForWorkspace', lenses[1].command.command === 'workspaceTheme.deleteThemeForWorkspace' && lenses[1].command.arguments[0] === '/config/workspace/aaa');
check('CodeLens: lines correct', lenses[0].range.startLine === 3 && lenses[2].range.startLine === 4);
check('CodeLens: [] when key absent', codeLensProvider.provideCodeLenses({ getText: () => '{"a":1}', positionAt: () => ({ line: 0 }) }).length === 0);

(async () => {
	const pick = registered['workspaceTheme.pickThemeForWorkspace'];

	// ---- Test 3: target = CURRENT via chooser -> pins workspace + map ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaOld' };
	store.wbGlobal = 'GlobalTheme'; store.wbWorkspace = 'AaaWsOld';
	vscodeMock.__simulatePick = 'Monokai';
	vscodeMock.__quickPickAnswer = { label: '/ws/aaa' };
	await pick();
	check('current: map[/ws/aaa] = Monokai', store.wt.themes['/ws/aaa'] === 'Monokai', JSON.stringify(store.wt.themes));
	check('current: workspace colorTheme pinned to Monokai', store.wbWorkspace === 'Monokai', store.wbWorkspace);

	// ---- Test 4: target = OTHER (bbb) via chooser -> save bbb, restore current ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme', '/ws/bbb': 'OldBbb' };
	store.wbGlobal = 'GlobalTheme'; store.wbWorkspace = 'AaaWsTheme';
	vscodeMock.__simulatePick = 'Solarized Dark';
	vscodeMock.__quickPickAnswer = { label: '/ws/bbb' };
	await pick();
	check('other: map[/ws/bbb] = Solarized Dark (saved to target)', store.wt.themes['/ws/bbb'] === 'Solarized Dark', JSON.stringify(store.wt.themes));
	check('other: current window restored', store.wbWorkspace === 'AaaWsTheme', store.wbWorkspace);
	check('other: current map entry untouched', store.wt.themes['/ws/aaa'] === 'AaaTheme');

	// ---- Test 5: CodeLens arg path skips the chooser ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme', '/ws/bbb': 'OldBbb' };
	store.wbGlobal = 'GlobalTheme'; store.wbWorkspace = 'AaaWsTheme';
	vscodeMock.__simulatePick = 'Red';
	vscodeMock.__quickPickAnswer = undefined; // chooser must NOT be needed
	await pick('/ws/bbb');
	check('codelens-arg: map[/ws/bbb] = Red without chooser', store.wt.themes['/ws/bbb'] === 'Red', JSON.stringify(store.wt.themes));
	check('codelens-arg: current restored', store.wbWorkspace === 'AaaWsTheme');

	// ---- Test 6: cancel (no pick) changes nothing ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme' };
	store.wbWorkspace = 'AaaWsTheme';
	vscodeMock.__simulatePick = undefined; // picker cancelled
	vscodeMock.__quickPickAnswer = { label: '/ws/aaa' };
	await pick();
	check('cancel: map unchanged', JSON.stringify(store.wt.themes) === JSON.stringify({ '/ws/aaa': 'AaaTheme' }));
	check('cancel: workspace theme unchanged', store.wbWorkspace === 'AaaWsTheme');

	const del = registered['workspaceTheme.deleteThemeForWorkspace'];

	// ---- Test 7: delete CURRENT window via chooser -> removes entry + clears override ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme', '/ws/bbb': 'BbbTheme' };
	store.wbGlobal = 'GlobalTheme'; store.wbWorkspace = 'AaaTheme';
	vscodeMock.__quickPickAnswer = { label: '/ws/aaa' };
	await del();
	check('delete-current: map entry removed', store.wt.themes['/ws/aaa'] === undefined, JSON.stringify(store.wt.themes));
	check('delete-current: other entry kept', store.wt.themes['/ws/bbb'] === 'BbbTheme');
	check('delete-current: workspace override cleared', store.wbWorkspace === undefined, String(store.wbWorkspace));

	// ---- Test 8: delete OTHER folder via chooser -> only its entry, current window untouched ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme', '/ws/bbb': 'BbbTheme' };
	store.wbWorkspace = 'AaaTheme';
	vscodeMock.__quickPickAnswer = { label: '/ws/bbb' };
	await del();
	check('delete-other: target entry removed', store.wt.themes['/ws/bbb'] === undefined, JSON.stringify(store.wt.themes));
	check('delete-other: current entry kept', store.wt.themes['/ws/aaa'] === 'AaaTheme');
	check('delete-other: current window override untouched', store.wbWorkspace === 'AaaTheme');

	// ---- Test 9: delete via CodeLens arg skips the chooser ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme', '/ws/bbb': 'BbbTheme' };
	store.wbWorkspace = 'AaaTheme';
	vscodeMock.__quickPickAnswer = undefined; // chooser must NOT be needed
	await del('/ws/bbb');
	check('delete-arg: target removed without chooser', store.wt.themes['/ws/bbb'] === undefined && store.wt.themes['/ws/aaa'] === 'AaaTheme', JSON.stringify(store.wt.themes));

	// ---- Test 10: delete cancelled (no chooser answer) changes nothing ----
	currentFolders = [{ uri: { fsPath: '/ws/aaa', scheme: 'file' }, name: 'aaa' }];
	store.wt.themes = { '/ws/aaa': 'AaaTheme' };
	store.wbWorkspace = 'AaaTheme';
	vscodeMock.__quickPickAnswer = undefined;
	await del();
	check('delete-cancel: map unchanged', store.wt.themes['/ws/aaa'] === 'AaaTheme');
	check('delete-cancel: override unchanged', store.wbWorkspace === 'AaaTheme');

	console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
	process.exit(failures === 0 ? 0 : 1);
})();
