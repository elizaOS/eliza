from os import path

APP_NAME = "unlock-veracrypt-volumes"
DATA_DIR = "/usr/share/tails/%s/" % APP_NAME
MAIN_UI_FILE = path.join(DATA_DIR, "main.ui")
VOLUME_UI_FILE = path.join(DATA_DIR, "volume.ui")
TRANSLATION_DOMAIN = "tails"
