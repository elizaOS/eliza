import subprocess


def is_password_set():
    output = subprocess.check_output(["/bin/passwd", "--status"])
    return output.split()[1] == b"P"
