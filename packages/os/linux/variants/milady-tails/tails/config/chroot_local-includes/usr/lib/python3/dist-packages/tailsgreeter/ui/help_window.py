import gi
import webbrowser

import tailsgreeter
from tailsgreeter.translatable_window import TranslatableWindow
from tailsgreeter.ui import _

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # NOQA: E402

PREFERRED_WIDTH = 800


class GreeterHelpWindow(Gtk.Window, TranslatableWindow):
    """Displays a modal HTML help window"""

    def __init__(self, uri):
        Gtk.Window.__init__(self, title=_(tailsgreeter.APPLICATION_TITLE))
        TranslatableWindow.__init__(self, self)

        self._build_ui()
        self.store_translations(self)

        self.load_uri(uri)
        # Replace the busy cursor set by the tails-greeter startup script with
        # the default cursor.
        self.get_window().set_cursor(None)

    def _build_ui(self):
        self.set_position(Gtk.WindowPosition.CENTER)

        # Create HeaderBar
        headerbar = Gtk.HeaderBar()
        headerbar.set_show_close_button(True)
        headerbar.show_all()

        # Create webview with custom stylesheet
        css = WebKit2.UserStyleSheet(
            ".sidebar, .banner { display: none; }",
            WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserStyleLevel.USER,
            None,
            None,
        )
        content_manager = WebKit2.UserContentManager()
        content_manager.add_style_sheet(css)
        self.webview = WebKit2.WebView.new_with_user_content_manager(content_manager)
        self.webview.connect("resource-load-started", self.cb_load_started)
        self.webview.show()

        scrolledwindow = Gtk.ScrolledWindow()
        scrolledwindow.add(self.webview)
        scrolledwindow.show()

        # Add children to ApplicationWindow
        self.add(scrolledwindow)
        self.set_titlebar(headerbar)

    def load_uri(self, uri):
        self.webview.load_uri(uri)
        self.resize(
            min(PREFERRED_WIDTH, self.get_screen().get_width()),
            self.get_screen().get_height(),
        )
        self.present()

    def cb_load_started(self, web_view, resource, request):
        if not request.get_uri().startswith("file://"):
            webbrowser.open_new(request.get_uri())
            request.set_uri(web_view.get_uri())
