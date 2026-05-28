# Copyright 2012-2019 Tails developers <foundations@tails.net>
# Copyright 2011 Max <govnototalitarizm@gmail.com>
# Copyright 2011 Martin Owens
#
# This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>
#

import gettext
import logging
from typing import ClassVar

from gi.repository import Gtk, Handy

import tailsgreeter.config
from tailsgreeter import TRANSLATION_DOMAIN


class TranslatableWindow:
    """
    Mixin providing functions to translate a window on the fly

    It works by adding two instance methods: store_translations (to be called early) and translate_to (to be called when you need to translate a window to a language).

    When the application wants to change the language on the fly, it needs to call TranslatableWindow.translate_all,
    which is a class method which will call translate_to for every language.
    Please note that this will have no effect on a TranslatableWindow created *after* translate_all has been invoked. In fact, TranslatableWindow are not automatically translated.
    """

    retain_focus = True
    registered_windows: ClassVar[list[Gtk.Window]] = []
    translation: ClassVar[gettext.NullTranslations] = gettext.translation(
        TRANSLATION_DOMAIN,
        tailsgreeter.config.system_locale_dir,
        fallback=True,
    )

    def __init__(self, window):
        self.window_ = window

        self.containers = []
        self.labels = {}
        self.placeholder_texts = {}
        self.subtitles = {}
        self.titles = {}
        self.tooltips = {}

        TranslatableWindow.registered_windows.append(window)

    @staticmethod
    def get_locale_direction(lang):
        """Return Gtk.TextDirection for lang

        This method in basically the same as Gtk.get_locale_direction
        (gtk_get_locale_direction in gtk/gtkmain.c), but it accepts a lang
        parameter rather than using current locale.
        """
        gtk_translation = gettext.translation(
            "gtk30",
            languages=[str(lang)],
            fallback=True,
        )
        logging.debug("%s has GTK translation: %s", lang, gtk_translation)
        # Translators: please do not translate this string (it is read from
        # Gtk translation)
        default_dir = gtk_translation.gettext("default:LTR")
        logging.debug("translation for direction is %s", default_dir)
        if default_dir == "default:RTL":
            logging.debug("%s is RTL", lang)
            return Gtk.TextDirection.RTL
        else:
            return Gtk.TextDirection.LTR

    def store_translations(self, widget):
        """Store the elements that should be localised inside widget

        Go through all children of widget and store the translations
        of labels, tooltips and titles and the containers whose text direction
        should be updated when switching between LTR and RTL.

        This method should be called once the widgets are created"""
        if not isinstance(widget, Gtk.Widget):
            logging.debug("%s is not a Gtk.Widget", widget)
            return
        if isinstance(widget, Gtk.Button | Gtk.Label):
            if widget not in self.labels:
                logging.debug(
                    "Storing translation for label/button '%s'",
                    widget.get_label(),
                )
                self.labels[widget] = widget.get_label()
                # Wrap set_label to get notified about string changes
                widget.original_set_label = widget.set_label

                def wrapped_set_label(text):
                    self.labels[widget] = text
                    widget.original_set_label(self.gettext(text))

                widget.set_label = wrapped_set_label
        elif isinstance(widget, Gtk.Entry):
            if widget not in self.placeholder_texts:
                logging.debug(
                    "Storing translation for entry '%s'",
                    widget.get_placeholder_text(),
                )
                self.placeholder_texts[widget] = widget.get_placeholder_text()
        elif isinstance(widget, Gtk.Container):
            logging.debug("Handling container '%s'", widget.get_name())
            self.containers.append(widget)
            if (
                (isinstance(widget, Gtk.HeaderBar | Gtk.Window | Handy.ActionRow))
                and widget not in self.titles
                and widget.get_title()
            ):
                self.titles[widget] = widget.get_title()
            if (
                isinstance(widget, Handy.ActionRow)
                and widget not in self.subtitles
                and widget.get_subtitle()
            ):
                self.subtitles[widget] = widget.get_subtitle()
            for child in widget.get_children():
                self.store_translations(child)
        else:
            logging.debug("W: unhandled widget: %s", widget)
        if widget.get_has_tooltip() and widget not in self.tooltips:
            self.tooltips[widget] = widget.get_tooltip_text()

    @classmethod
    def gettext(cls, text):
        """Return text, translated if possible"""
        if cls.translation and text:
            text = cls.translation.gettext(text)
        return text

    def translate_to(self, lang):
        """Translate registered widgets on the fly

        Loop through widgets registered with store_translations and translate
        them on the fly"""
        logging.debug("translating %s to %s", self, lang)

        text_direction = self.get_locale_direction(lang)
        for container in self.containers:
            container.set_default_direction(text_direction)
        for widget, label in self.labels.items():
            if label:
                widget.original_set_label(self.gettext(label))
        for widget in self.placeholder_texts:
            widget.set_placeholder_text(self.gettext(self.placeholder_texts[widget]))
        for widget in self.subtitles:
            widget.set_subtitle(self.gettext(self.subtitles[widget]))
        for widget in self.titles:
            widget.set_title(self.gettext(self.titles[widget]))
        for widget in self.tooltips:
            widget.set_tooltip_markup(self.gettext(self.tooltips[widget]))
        if (
            self.window_.get_sensitive()
            and self.window_.get_visible()
            and self.retain_focus
        ):
            self.window_.present()

    @classmethod
    def translate_all(cls, lang):
        try:
            cls.translation = gettext.translation(
                TRANSLATION_DOMAIN,
                tailsgreeter.config.system_locale_dir,
                [str(lang)],
            )
        except OSError:
            cls.translation = None

        for widget in cls.registered_windows:
            logging.debug("Translating %s", str(widget))
            widget.translate_to(lang)


translate = TranslatableWindow.gettext
