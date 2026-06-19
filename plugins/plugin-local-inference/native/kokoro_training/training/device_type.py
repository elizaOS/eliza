from enum import Enum


class DeviceType(Enum):
    CUDA = "cuda"
    MPS = "mps"
    CPU = "cpu"
