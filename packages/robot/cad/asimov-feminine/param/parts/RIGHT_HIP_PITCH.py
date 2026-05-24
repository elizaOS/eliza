"""Feminize the RIGHT_HIP_PITCH hip link. See _hip_common.py for the shared pipeline."""
import _hip_common as H

if __name__ == "__main__":
    rep = H.process("RIGHT_HIP_PITCH", render=True)
    print(rep)
