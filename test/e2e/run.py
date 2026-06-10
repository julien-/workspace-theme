import json, re, time, sys, traceback
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

CODE_URL = "http://code:8080"
CHROME = "http://chrome:4444"
fails = []

def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL") + f"  {name}" + (f"   [{extra}]" if extra and not cond else ""), flush=True)
    if not cond:
        fails.append(name)

def read_json(p):
    with open(p) as f:
        t = f.read()
    t = re.sub(r'//.*', '', t)
    return json.loads(t)

def wait_code():
    import urllib.request
    for _ in range(60):
        try:
            urllib.request.urlopen(CODE_URL, timeout=3)
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError("code-server never became reachable")

def new_driver():
    opts = Options()
    opts.add_argument("--window-size=1600,1000")
    opts.add_argument("--no-sandbox")
    for _ in range(30):
        try:
            return webdriver.Remote(command_executor=CHROME, options=opts)
        except Exception:
            time.sleep(2)
    raise RuntimeError("chrome webdriver never became reachable")

def open_folder(driver, path):
    driver.get(f"{CODE_URL}/?folder={path}")
    WebDriverWait(driver, 60).until(EC.presence_of_element_located((By.CSS_SELECTOR, ".monaco-workbench")))
    time.sleep(10)  # let the workbench settle + our extension activate (onStartupFinished)

def palette(driver):
    ActionChains(driver).key_down(Keys.CONTROL).key_down(Keys.SHIFT).send_keys("p").key_up(Keys.SHIFT).key_up(Keys.CONTROL).perform()

def qi(driver, timeout=20):
    WebDriverWait(driver, timeout).until(EC.visibility_of_element_located((By.CSS_SELECTOR, ".quick-input-widget")))
    return WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ".quick-input-widget input")))

def type_and_enter(driver, text, settle=1.2):
    el = qi(driver)
    el.clear()
    el.send_keys(text)
    time.sleep(settle)        # let the list filter / preview apply
    el.send_keys(Keys.ENTER)
    time.sleep(settle)

def run_command(driver, name):
    palette(driver)
    time.sleep(0.6)
    inp = qi(driver)
    inp.send_keys(name)
    time.sleep(1.2)
    inp.send_keys(Keys.ENTER)
    time.sleep(1.0)

def shot(driver, name):
    try:
        driver.save_screenshot(f"/test/{name}.png")
    except Exception:
        pass

def main():
    wait_code()
    driver = new_driver()
    try:
        # ---------- TEST A: Set workspace theme, target = current (aaa) ----------
        open_folder(driver, "/ws/aaa")
        shot(driver, "01_aaa_open")
        run_command(driver, "Set workspace theme")
        shot(driver, "02a_target_pick_A")
        # target chooser -> pick the current workspace (/ws/aaa)
        type_and_enter(driver, "/ws/aaa", settle=1.5)
        shot(driver, "02_theme_picker")
        # native theme picker is now open -> choose a distinctive theme
        type_and_enter(driver, "Abyss", settle=1.5)
        time.sleep(2.0)  # let the extension capture + persist (300ms grace + writes)
        shot(driver, "03_after_pick_A")

        ws = read_json("/ws/aaa/.vscode/settings.json")
        usr = read_json("/ud/User/settings.json")
        check("A: aaa workspace colorTheme == Abyss", ws.get("workbench.colorTheme") == "Abyss",
              f"got {ws.get('workbench.colorTheme')}")
        check("A: central map themes[/ws/aaa] == Abyss", usr.get("workspaceTheme", {}).get("/ws/aaa") == "Abyss" or usr.get("workspaceTheme.themes", {}).get("/ws/aaa") == "Abyss",
              f"map={usr.get('workspaceTheme.themes') or usr.get('workspaceTheme')}")

        # ---------- TEST B: Set workspace theme, target bbb from aaa ----------
        bbb_before = read_json("/ws/bbb/.vscode/settings.json").get("workbench.colorTheme")
        run_command(driver, "Set workspace theme")
        shot(driver, "04_target_pick")
        # target quick pick -> choose bbb
        type_and_enter(driver, "/ws/bbb", settle=1.5)
        shot(driver, "05_theme_picker_B")
        # native theme picker -> choose Red
        type_and_enter(driver, "Red", settle=1.5)
        time.sleep(2.0)
        shot(driver, "06_after_pick_B")

        usr2 = read_json("/ud/User/settings.json")
        themes2 = usr2.get("workspaceTheme.themes") or {}
        aaa_ws = read_json("/ws/aaa/.vscode/settings.json").get("workbench.colorTheme")
        check("B: central map themes[/ws/bbb] == Red (saved to TARGET)", themes2.get("/ws/bbb") == "Red",
              f"map={themes2}")
        check("B: current window aaa NOT left on Red (restored)", aaa_ws != "Red", f"aaa colorTheme={aaa_ws}")
        check("B: aaa entry still Abyss (current map untouched)", themes2.get("/ws/aaa") == "Abyss",
              f"map={themes2}")

        print("\nMAP NOW: " + json.dumps(themes2), flush=True)
    except Exception as e:
        traceback.print_exc()
        shot(driver, "99_error")
        fails.append("exception: " + str(e))
    finally:
        try:
            driver.quit()
        except Exception:
            pass
    print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILURE(S): ' + ', '.join(fails)}", flush=True)
    sys.exit(0 if not fails else 1)

main()
