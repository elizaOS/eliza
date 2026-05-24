"""Feminize the RIGHT_HIP_ROLL hip link. See _hip_common.py for the shared pipeline."""
import _hip_common as H

if __name__ == "__main__":
    rep = H.process("RIGHT_HIP_ROLL", render=True)
    print(rep)
