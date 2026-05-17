import subprocess
from gi.repository import Gtk

from tps_frontend import _


def set_passphrase_strength_hint(progress_bar: Gtk.ProgressBar, passhrase: str):
    def get_passphrase_strength() -> float:
        # Compute passphrase strength
        p = subprocess.run(
            ["pwscore"],
            input=passhrase,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if p.returncode != 0:
            # We assume that an error return code always means that the
            # password quality check failed
            set_progress_bar_class("weak")
            return 0.02

        # Calculate the fraction that we'll display in the progress bar
        return int(p.stdout) / 100

    def set_progress_bar_class(class_name: str):
        # Remove other classes
        for c in progress_bar_style_context.list_classes():
            progress_bar_style_context.remove_class(c)
        progress_bar_style_context.add_class(class_name)

    progress_bar_style_context = (
        progress_bar.get_style_context()
    )  # type: Gtk.StyleContext

    if len(passhrase) == 0:
        hint = ""
        strength = 0.0
    else:
        strength = get_passphrase_strength()
        # We use the same hints for the same strength as
        # gnome-disk-utility
        if strength < 0.5:
            hint = _("Weak")
            set_progress_bar_class("weak")
        elif strength < 0.75:
            hint = _("Fair")
            set_progress_bar_class("fair")
        elif strength < 0.90:
            hint = _("Good")
            set_progress_bar_class("good")
        else:
            hint = _("Strong")
            set_progress_bar_class("strong")

    progress_bar.set_fraction(strength)
    progress_bar.set_text(hint)
