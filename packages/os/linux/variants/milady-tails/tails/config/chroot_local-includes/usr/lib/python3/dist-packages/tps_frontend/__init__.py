import gettext
from os import path

_ = gettext.gettext

TRANSLATION_DOMAIN = "tails"
APPLICATION_ID = "org.boum.tails.PersistentStorage"

PACKAGE_PATH = path.dirname(path.realpath(__file__))

DBUS_SERVICE_NAME = "org.boum.tails.PersistentStorage"
DBUS_ROOT_OBJECT_PATH = "/org/boum/tails/PersistentStorage"
DBUS_FEATURES_PATH = "/org/boum/tails/PersistentStorage/Features"
DBUS_JOBS_PATH = "/org/boum/tails/PersistentStorage/Jobs"
DBUS_SERVICE_INTERFACE = "org.boum.tails.PersistentStorage"
DBUS_FEATURE_INTERFACE = "org.boum.tails.PersistentStorage.Feature"
DBUS_JOB_INTERFACE = "org.boum.tails.PersistentStorage.Job"

DATA_DIR = "/usr/share/tails/persistent-storage"
ICON_DIR = path.join(DATA_DIR, "icons")

CSS_FILE = path.join(DATA_DIR, "style.css")

CREATION_VIEW_UI_FILE = path.join(DATA_DIR, "creation_view.ui")
CUSTOM_FEATURE_UI_FILE = path.join(DATA_DIR, "custom_feature.ui")
DELETED_VIEW_UI_FILE = path.join(DATA_DIR, "deleted_view.ui")
FAIL_VIEW_UI_FILE = path.join(DATA_DIR, "fail_view.ui")
FEATURES_VIEW_UI_FILE = path.join(DATA_DIR, "features_view.ui")
PASSPHRASE_VIEW_UI_FILE = path.join(DATA_DIR, "passphrase_view.ui")
SPINNER_VIEW_UI_FILE = path.join(DATA_DIR, "spinner_view.ui")
LOCKED_VIEW_UI_FILE = path.join(DATA_DIR, "locked_view.ui")
WELCOME_VIEW_UI_FILE = path.join(DATA_DIR, "welcome_view.ui")
WINDOW_UI_FILE = path.join(DATA_DIR, "window.ui")


CHANGE_PASSPHRASE_DIALOG_UI_FILE = path.join(DATA_DIR, "change_passphrase_dialog.ui")
