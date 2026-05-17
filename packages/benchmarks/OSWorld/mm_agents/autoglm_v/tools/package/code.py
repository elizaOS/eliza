import json
import os
import subprocess
from pathlib import Path


class CodeTools:
    ret = ""

    @classmethod
    def print_result(cls):
        """打印执行结果"""
        print(cls.ret)

    @classmethod
    def launch_vscode(cls, path):
        """
        Launches Visual Studio Code with the specified file path or directory.
        在存在的窗口中打开一个文件或目录。

        Args:
            path (str): 文件路径或目录。
        """
        try:
            subprocess.run(["code", "-r", path], check=True)
            cls.ret = "Successfully launched VS Code"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error launching VS Code: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def env_info(cls):
        cls.ret = "None"

    @classmethod
    def compare_files(cls, file1, file2):
        """
        Compares two files in VSCode.
        在VSCode中比较两个文件。

        Args:
            file1 (str): 第一个文件的路径。
            file2 (str): 第二个文件的路径。
        """
        try:
            # 获取compare结果
            subprocess.run(["code", "-d", file1, file2], check=True)
            cls.ret = "The compared files are opened in VSCode"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error comparing files: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def add_folder(cls, folder):
        """
        Adds a folder to the last active window in VSCode.
        向VSCode的最后一个活动窗口添加文件夹。

        Args:
            folder (str): 文件夹路径。
        """
        try:
            subprocess.run(["code", "-a", folder], check=True)
            cls.ret = "Successfully added folder"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error adding folder: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def goto_file(cls, file_path, line=1, character=1):
        """
        Opens a file at a specific line and character position.
        在特定行和字符的位置打开文件。

        Args:
            file_path (str): 文件路径。
            line (int): 行号。
            character (int): 字符位置。
        """
        try:
            command = f"{file_path}:{line}:{character}"
            subprocess.run(["code", "-g", command], check=True)
            cls.ret = "Successfully opened file, line: {}, character: {}".format(line, character)
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error going to file: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def perform_merge(cls, path1, path2, base, result):
        """
        Perform a three-way merge.
        执行三方合并。

        Args:
            path1 (str): 第一版本文件路径。
            path2 (str): 第二版本文件路径。
            base (str): 基础版本文件路径。
            result (str): 结果文件的保存路径。
        """
        try:
            subprocess.run(["code", "-m", path1, path2, base, result], check=True)
            cls.ret = "Successfully performed merge"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error performing merge: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def remove_folder(cls, folder):
        """
        Removes a folder from the last active window in VSCode.
        在VSCode的最后一个活动窗口中移除文件夹。

        Args:
            folder (str): 文件夹路径。
        """
        try:
            subprocess.run(["code", "--remove", folder], check=True)
            cls.ret = "Successfully removed folder"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error removing folder: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def install_extension(cls, extension_id, pre_release=False):
        """
        Installs an extension or updates it in VSCode.
        安装或更新VSCode中的扩展。

        Args:
            extension_id (str): 扩展的标识符。
            pre_release (bool): 是否安装预发布版本。
        """
        try:
            command = ["code", "--install-extension", extension_id]
            if pre_release:
                command.append("--pre-release")
            subprocess.run(command, check=True)
            cls.ret = "Successfully installed extension"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error installing extension: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def uninstall_extension(cls, extension_id):
        """
        Uninstalls an extension from VSCode.
        从VSCode中卸载扩展。

        Args:
            extension_id (str): 扩展的标识符。
        """
        try:
            subprocess.run(["code", "--uninstall-extension", extension_id], check=True)
            cls.ret = "Successfully uninstalled extension"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error uninstalling extension: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def list_extensions(cls, show_versions=False, category=None):
        """
        Lists installed extensions in VSCode.
        列出VSCode中安装的扩展。

        Args:
            show_versions (bool): 是否显示扩展的版本。
            category (str): 按类别筛选扩展。
        """
        try:
            command = ["code", "--list-extensions"]
            if show_versions:
                command.append("--show-versions")
            if category:
                command.extend(["--category", category])
            cls.ret = subprocess.run(command, check=True, capture_output=True, text=True).stdout
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error listing extensions: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def update_extensions(cls):
        """
        Updates all installed extensions in VSCode to the latest version.
        更新VSCode中所有安装的扩展到最新版本。
        """
        try:
            subprocess.run(["code", "--update-extensions"], check=True)
            cls.ret = "Successfully updated extensions"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error updating extensions: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def disable_extension(cls, extension_id):
        """
        Disables a specific extension for the next instance of VSCode.
        禁用在下一个VSCode窗口中的指定扩展。

        Args:
            extension_id (str): 扩展的标识符。
        """
        try:
            subprocess.run(["code", "--disable-extension", extension_id], check=True)
            cls.ret = "Successfully disabled extension"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error disabling extension: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret

    @classmethod
    def toggle_sync(cls, state):
        """
        Toggles synchronization on or off in VSCode.
        在VSCode中开启或关闭同步。

        Args:
            state (str): 'on' 或 'off' 表示开启或关闭。
        """
        try:
            command = ["code", "--sync", state]
            subprocess.run(command, check=True)
            cls.ret = "Successfully toggled sync"
        except subprocess.CalledProcessError as e:
            cls.ret = f"Error toggling sync: {e}"
        except Exception as e:
            cls.ret = f"Unexpected error: {e}"

        return cls.ret
