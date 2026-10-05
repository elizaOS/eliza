import json
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import requests
from requests.auth import HTTPBasicAuth


class VLCTools:
    host = "localhost"
    port = 8080
    base_url = f"http://{host}:{port}/requests"
    password = "password"
    auth = HTTPBasicAuth("", password)
    ret = ""

    @classmethod
    def print_result(cls):
        print(cls.ret)

    @classmethod
    def _make_request(cls, endpoint, params=None):
        url = f"{cls.base_url}/{endpoint}"
        try:
            response = requests.get(url, params=params, auth=cls.auth)
            response.raise_for_status()
            return response
        except requests.exceptions.RequestException as e:
            return None

    @classmethod
    def _get_status(cls):
        response = cls._make_request("status.xml")
        if response:
            return ET.fromstring(response.content)
        return None

    @classmethod
    def env_info(cls):
        cls.ret = "None"

    @classmethod
    def get_playlist(cls):
        response = cls._make_request("playlist.xml")
        if response:
            info = ET.fromstring(response.content)
            playlist_node = info.find('.//node[@name="Playlist"]')
            if playlist_node is not None:
                playlist_items = []
                for leaf in playlist_node.findall("leaf"):
                    item = {"name": leaf.get("name"), "uri": leaf.get("uri"), "duration": leaf.get("duration") + "s"}
                    playlist_items.append(item)
            cls.ret = f"Playlist: {playlist_items}"
            return cls.ret
        cls.ret = "Error getting playlist"
        return None

    @classmethod
    def play(cls):
        response = cls._make_request("status.xml", {"command": "pl_play"})
        if response:
            cls.ret = "Start playing the media"
            return cls.ret
        cls.ret = "Error playing the media"
        return None

    @classmethod
    def pause(cls):
        response = cls._make_request("status.xml", {"command": "pl_pause"})
        if response:
            cls.ret = "Pause the media"
            return cls.ret
        cls.ret = "Error pausing the media"
        return None

    @classmethod
    def next(cls):
        response = cls._make_request("status.xml", {"command": "pl_next"})
        if response:
            cls.ret = "Switch to next media"
            return cls.ret
        cls.ret = "Error switching to next media"
        return None

    @classmethod
    def previous(cls):
        response = cls._make_request("status.xml", {"command": "pl_previous"})
        if response:
            cls.ret = "Switch to previous media"
            return cls.ret
        cls.ret = "Error switching to previous media"
        return None

    @classmethod
    def add_to_playlist(cls, uri):
        if uri.startswith("http"):
            encoded_uri = uri
        else:
            encoded_uri = "file://" + quote(uri.replace("file://", ""))

        response = cls._make_request("status.xml", {"command": "in_play", "input": encoded_uri})
        if response:
            cls.ret = f"Add {uri} to playlist"
            return cls.ret
        cls.ret = f"Error adding {uri} to playlist"
        return None

    @classmethod
    def get_current_time(cls):
        status = cls._get_status()
        if status is not None:
            time = status.find("time")
            cls.ret = int(time.text) if time is not None else None
            return cls.ret
        return None

    @classmethod
    def get_media_duration(cls):
        status = cls._get_status()
        if status is not None:
            length = status.find("length")
            if length is not None:
                cls.ret = f"Media duration: {length.text} seconds"
                return cls.ret
        cls.ret = "Error getting media duration"
        return None

    @classmethod
    def get_settings(cls):
        settings = {}
        with open(Path.home() / ".config/vlc/vlcrc", "r") as f:
            for line in f:
                if line:
                    try:
                        key, value = line.split("=")
                        if key.strip().startswith("#"):
                            continue
                        settings[key.strip()] = value.strip()
                    except:
                        continue
        cls.ret = json.dumps(settings, indent=4, ensure_ascii=False)
        return cls.ret

    @classmethod
    def set_settings(cls, field, value):
        with open(Path.home() / ".config/vlc/vlcrc", "r") as rf:
            settings = rf.read()

        # 正则表达式匹配settings中的field项并替换
        pattern = re.compile(r"#? *" + re.escape(field) + r"=.*")
        # 判断是否存在field项
        if pattern.search(settings):
            settings = pattern.sub(f"{field}={value}", settings)
        else:
            settings += f"{field}={value}\n"

        with open(Path.home() / ".config/vlc/vlcrc", "w") as wf:
            wf.write(settings)

        cls.ret = f"Set {field} to {value}"
        return cls.ret

    @classmethod
    def toggle_fullscreen(cls, enable=None):
        """
        Toggle fullscreen mode or set it explicitly based on the enable parameter.

        Args:
            enable (bool, optional): If provided, explicitly set fullscreen mode (True for fullscreen, False for windowed)

        Returns:
            str: Success or error message
        """
        if enable is not None:
            command = "fullscreen" if enable else "fullscreen off"
        else:
            command = "fullscreen"
        response = cls._make_request("status.xml", {"command": command})
        if response:
            action = "enabled" if enable is True else "disabled" if enable is False else "toggled"
            cls.ret = f"Fullscreen mode {action}"
            return cls.ret
        cls.ret = "Error changing fullscreen mode"
        return None

    @classmethod
    def get_media_files(cls, path, suffix=None):
        """
        Gets the media files for the specified path.

        Args:
            path (str): The path to the media files
            suffix (List[str], optional): The suffix of the media files.
                Defaults to ['mp4', 'avi', 'mkv', 'mov', 'mp3', 'm4a', 'wav']
        """
        # Set default suffix if not provided
        if suffix is None:
            suffix = ["mp4", "avi", "mkv", "mov", "mp3", "m4a", "wav"]

        # Validate path
        if not path:
            cls.ret = "Path cannot be empty"
            return None

        if not os.path.exists(path):
            cls.ret = f"Path not found: {path}"
            return None

        # Initialize result list
        media_files = []

        # Convert suffix list to lowercase for case-insensitive comparison
        suffix = [s.lower() for s in suffix]

        # Walk through directory
        try:
            for root, _, files in os.walk(path):
                for file in files:
                    # Check if file extension matches any of the specified suffixes
                    if any(file.lower().endswith(f".{s}") for s in suffix):
                        # Add full path of the file to results
                        full_path = os.path.join(root, file)
                        media_files.append(full_path)

        except Exception as e:
            cls.ret = f"Error while scanning directory: {str(e)}"
            return None

        cls.ret = media_files
        return cls.ret
