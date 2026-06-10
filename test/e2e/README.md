# End-to-end test (real browser)

`scripts/test-harness.js` (`npm test`) validates the logic against a mocked `vscode`. This e2e drives the **real** native theme picker in a real code-server via Selenium, to catch timing/integration issues the mock cannot (this is how the `runNativePicker` event-capture fix was verified).

## What it does

Brings up three containers (`code` = codercom/code-server with the extension installed, `chrome` = selenium/standalone-chromium, `tester` = python running `run.py`) and asserts, by reading the on-disk settings files:

- **Set workspace theme** with target = current (`aaa`) → writes `aaa/.vscode/settings.json` `colorTheme` and the central `workspaceTheme.themes["/ws/aaa"]`.
- **Set workspace theme** targeting `bbb` from `aaa` → saves to `themes["/ws/bbb"]`, restores the `aaa` window, leaves the `aaa` entry untouched.

## Running it

It expects a fixture working dir on a **host-valid path** (sibling containers bind-mount from the host, so `/tmp` inside the IDE container does NOT work - use `/config/workspace/...`). Recreate:

```
WT=/config/workspace/wt-test
mkdir -p $WT/{extensions,userdata/User,ws/aaa/.vscode,ws/bbb/.vscode,test}
# userdata/User/settings.json: security.workspace.trust.enabled=false, autoGitExclude=false,
#   workspaceTheme.themes = { "/ws/aaa": "Tomorrow Night Blue", "/ws/bbb": "Monokai" }
# ws/aaa/.vscode/settings.json: { "workbench.colorTheme": "Tomorrow Night Blue" }
# ws/bbb/.vscode/settings.json: { "workbench.colorTheme": "Monokai" }
code-server --install-extension <vsix> --extensions-dir $WT/extensions
cp test/e2e/docker-compose.test.yml $WT/ ; cp test/e2e/run.py $WT/test/
chmod -R 777 $WT
cd $WT && docker compose -f docker-compose.test.yml up -d code chrome
docker compose -f docker-compose.test.yml run --rm tester     # prints PASS/FAIL, screenshots to test/
docker compose -f docker-compose.test.yml down
```
