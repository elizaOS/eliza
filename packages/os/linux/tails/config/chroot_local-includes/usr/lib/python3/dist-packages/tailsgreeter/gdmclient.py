# Copyright 2013-2016 Tails developers <foundations@tails.net>
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
"""
A very simple GDM client
"""

import gi
import logging

gi.require_version("Gdm", "1.0")
from gi.repository import Gdm  # NOQA: E402

import tailsgreeter.config  # NOQA: E402
import tailsgreeter.errors  # NOQA: E402


class GdmClient:
    """Greeter client class"""

    def __init__(self, session_opened_cb=None):
        self.session_opened_cb = session_opened_cb

        greeter_client = Gdm.Client()
        self.__greeter = greeter_client.get_greeter_sync(None)

        self.__greeter.connect(
            "default-session-name-changed", self.__on_default_session_changed
        )
        self.__greeter.connect("session-opened", self.__on_session_opened)
        self.__greeter.connect("timed-login-requested", self.__on_timed_login_requested)

        self.__user_verifier = greeter_client.get_user_verifier_sync(None)
        self.__user_verifier.connect("info", self.__on_info)
        self.__user_verifier.connect("problem", self.__on_problem)
        self.__user_verifier.connect("info_query", self.__on_info_query)
        self.__user_verifier.connect("secret_info_query", self.__on_secret_info_query)
        self.__user_verifier.connect(
            "conversation-stopped", self.__on_conversation_stopped
        )
        self.__user_verifier.connect("reset", self.__on_reset)
        self.__user_verifier.connect(
            "verification-complete", self.__on_verification_complete
        )

    def __on_info(self, client, service_name, info):
        logging.debug(f"Received info {info} from {service_name}")

    def __on_problem(self, client, service_name, problem):
        logging.debug(f"Received problem {problem} from {service_name}")
        raise tailsgreeter.errors.GdmServerError(problem)

    def __on_info_query(self, client, service_name, question):
        logging.debug(f"Received info_query {question} from {service_name}")
        raise NotImplementedError

    def __on_secret_info_query(self, client, service_name, secret_question):
        logging.debug(
            f"Received secret_info_query {secret_question} from {service_name}"
        )
        self.__user_verifier.call_answer_query(
            service_name, tailsgreeter.config.LPASSWORD, None, None, None
        )

    def __on_conversation_stopped(self, client, service_name):
        logging.debug("Received conversation-stopped from %s" % service_name)

    def __on_reset(self):
        logging.debug("Received reset")
        raise NotImplementedError

    def __on_verification_complete(self, *args):
        logging.debug("Received verification-complete")

    def __on_session_opened(self, client, service_name, _unused):
        logging.debug("Received session-opened with %s" % service_name)
        if self.session_opened_cb:
            self.session_opened_cb()
        self.__greeter.call_start_session_when_ready_sync(service_name, True, None)
        logging.debug("start_session_when_ready_sync called")

    def __on_default_session_changed(self, client, session_id):
        logging.debug("Received default-session-name-changed: %s" % session_id)

    def __on_timed_login_requested(self, client, user_name, seconds):
        logging.debug(f"Received timed-login-requested for {user_name} in {seconds}")
        raise NotImplementedError

    def do_login(self):
        """Login using autologin"""
        logging.debug("Begin verification")
        self.__user_verifier.call_begin_verification_for_user_sync(
            "gdm-password", tailsgreeter.config.LUSER, None
        )
