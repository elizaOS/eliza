from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[2]
source = root / "website"
out = root / "site-build"

directories = (
    "admin api app assets chrome connect contact cookies dashboard demo disclosure "
    "extension faq health kernel media os pay preview privacy shop status terms tools volos "
    "updates whitepaper"
).split()
files = (
    "404.html ads.txt app-ads.txt changelog.json connect-core.js consent.js supabase.js "
    "desk.css desk.js disclaimer.md errors.js faq.json googlec12e36a98a292c4c.html hive-core.js "
    "home-motion.js home.css home.js index.html landing.css manifest.webmanifest "
    "merch-promo.js monetization.json nacl.min.js offers.json privacy-policy.md "
    "robots.txt site-chrome.js site-config.js site-motion.js site-offers.js "
    "site-wallet.js site.js sitemap.xml status.js styles.css terms.md ticker.js visual.css "
    "trust.js valhalla-command.css version.json"
).split()

if out.exists():
    shutil.rmtree(out)
out.mkdir()
for name in directories:
    shutil.copytree(source / name, out / name, ignore=shutil.ignore_patterns(
        "*.test.js", "*.test.mjs", "*.test.cjs", "__pycache__", ".*"
    ))
for name in files:
    shutil.copy2(source / name, out / name)
entrance = out / "home"
entrance.mkdir()
(out / "index.html").rename(entrance / "index.html")

# Match the upstream Pages build: do not cover the sign-in page with the preview iframe.
errors = out / "errors.js"
text = errors.read_text()
needle = "frame.title = 'Valhalla read-only preview';"
if needle in text:
    start = text.rfind("\n(function () {", 0, text.index(needle))
    if start < 0:
        raise RuntimeError("Cannot locate preview overlay")
    text = text[:start] + "\n"
if "root.ValhallaErrors = " not in text:
    raise RuntimeError("Missing error handler")
errors.write_text(text)

for name in ("home/index.html", "app/index.html", "app/gate.js", "assets/mark.svg",
             "assets/mech.jpg", "assets/poster.jpg", "media/hero.mp4",
             "connect-core.js", "site-wallet.js", "desk.js", "desk.css"):
    if not (out / name).is_file() or not (out / name).stat().st_size:
        raise RuntimeError("Missing required site file: " + name)
