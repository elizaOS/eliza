from dataclasses import dataclass

import numpy as np

FORMANT_FREQUENCIES: dict[int, tuple[int, int, int]] = {
    0: (730, 1090, 2440),  # a
    1: (730, 1090, 2440),
    2: (530, 1840, 2480),  # e
    3: (530, 1840, 2480),
    4: (390, 1990, 2550),  # i
    5: (390, 1990, 2550),
    6: (570, 840, 2410),  # o
    7: (570, 840, 2410),
    8: (440, 1020, 2240),  # u
    9: (440, 1020, 2240),
    10: (200, 900, 2200),  # b
    11: (200, 1800, 2600),  # c
    12: (200, 1700, 2600),  # d
    13: (200, 1400, 2200),  # f
    14: (200, 1800, 2300),  # g
    15: (200, 1200, 2500),  # h
    16: (200, 2000, 2700),  # j
    17: (200, 1800, 2400),  # k
    18: (350, 1200, 2600),  # l
    19: (200, 900, 2200),  # m
    20: (200, 1100, 2400),  # n
    21: (200, 900, 2100),  # p
    22: (200, 1800, 2400),  # q
    23: (350, 1300, 1700),  # r
    24: (200, 1600, 2600),  # s
    25: (200, 1800, 2600),  # t
    26: (200, 1200, 2200),  # v
    27: (200, 700, 2200),  # w
    28: (200, 1600, 2600),  # x
    29: (200, 2200, 2800),  # y
    30: (200, 1500, 2500),  # z
    31: (0, 0, 0),  # silence
}

PHONEME_MAP: dict[str, tuple[int, ...]] = {
    "a": (0, 1),
    "e": (2, 3),
    "i": (4, 5),
    "o": (6, 7),
    "u": (8, 9),
    "b": (10,),
    "c": (11,),
    "d": (12,),
    "f": (13,),
    "g": (14,),
    "h": (15,),
    "j": (16,),
    "k": (17,),
    "l": (18,),
    "m": (19,),
    "n": (20,),
    "p": (21,),
    "q": (22,),
    "r": (23,),
    "s": (24,),
    "t": (25,),
    "v": (26,),
    "w": (27,),
    "x": (28,),
    "y": (29,),
    "z": (30,),
    " ": (31,),
}


@dataclass
class SamEngine:
    speed: int = 72
    pitch: int = 64
    throat: int = 128
    mouth: int = 128
    sample_rate: int = 22050

    def text_to_phonemes(self, text: str) -> list[int]:
        phonemes: list[int] = []
        for char in text.lower():
            if char in PHONEME_MAP:
                phonemes.extend(PHONEME_MAP[char])
            elif char in ".,!?;:":
                phonemes.extend((31, 31))
            elif char.isalpha():
                phonemes.extend(PHONEME_MAP["a"])
            else:
                phonemes.append(31)
        return phonemes

    def synthesize_phoneme(self, phoneme: int, duration_ms: int = 80) -> np.ndarray:
        speed_factor = 100.0 / max(1, self.speed)
        duration_samples = int(duration_ms * speed_factor * self.sample_rate / 1000)

        if duration_samples <= 0:
            return np.array([], dtype=np.float32)

        formants = FORMANT_FREQUENCIES.get(phoneme, (200, 1200, 2400))
        f1, f2, _ = formants

        pitch_factor = self.pitch / 64.0
        throat_factor = self.throat / 128.0
        mouth_factor = self.mouth / 128.0

        f1 = int(f1 * pitch_factor * throat_factor)
        f2 = int(f2 * pitch_factor * mouth_factor)

        fundamental_freq = 80 + (self.pitch / 2)
        t = np.arange(duration_samples) / self.sample_rate
        wave = np.zeros(duration_samples, dtype=np.float32)

        for harmonic in range(1, 8):
            freq = fundamental_freq * harmonic
            amp = 1.0 / harmonic
            wave += amp * np.sin(2 * np.pi * freq * t).astype(np.float32)

        if f1 > 0:
            formant1 = 0.5 * np.sin(2 * np.pi * f1 * t).astype(np.float32)
            wave = wave * (1 + 0.3 * formant1)

        attack = min(duration_samples // 10, 100)
        release = min(duration_samples // 5, 200)

        envelope = np.ones(duration_samples, dtype=np.float32)
        if attack > 0:
            envelope[:attack] = np.linspace(0, 1, attack, dtype=np.float32)
        if release > 0:
            envelope[-release:] = np.linspace(1, 0, release, dtype=np.float32)

        wave = wave * envelope

        max_val = np.max(np.abs(wave))
        if max_val > 0:
            wave = wave / max_val

        return wave

    def synthesize(self, text: str) -> bytes:
        phonemes = self.text_to_phonemes(text)

        segments = [self.synthesize_phoneme(p) for p in phonemes]
        segments = [s for s in segments if len(s) > 0]

        if not segments:
            return bytes([128] * 100)

        audio = np.concatenate(segments)
        audio_normalized = (audio + 1.0) / 2.0
        return bytes((audio_normalized * 255).astype(np.uint8))

    def buf8(self, text: str) -> bytes:
        return self.synthesize(text)
