# Translation stuff

import os
import gettext


if os.path.exists("po/locale"):
    translation = gettext.translation("tails", "po/locale", fallback=True)
else:
    translation = gettext.translation("tails", "/usr/share/locale", fallback=True)

_ = translation.gettext
