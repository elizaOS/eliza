"""Feminize LEFT_SHOULDER_ROLL. See _shoulder_common.py for the shared pipeline."""
from _shoulder_common import build

if __name__ == "__main__":
    import sys
    build("LEFT_SHOULDER_ROLL", render="--render" in sys.argv)
