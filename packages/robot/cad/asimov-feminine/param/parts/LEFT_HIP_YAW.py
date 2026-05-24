"""Feminize the LEFT_HIP_YAW hip link. See _hip_common.py for the shared pipeline."""
import _hip_common as H

if __name__ == "__main__":
    rep = H.process("LEFT_HIP_YAW", render=True)
    print(rep)
