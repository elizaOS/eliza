#![allow(missing_docs)]

use crate::types::SamTTSOptions;
use std::f32::consts::PI;

const FORMANT_FREQUENCIES: [(u16, u16, u16); 32] = [
    (730, 1090, 2440),
    (730, 1090, 2440), // a
    (530, 1840, 2480),
    (530, 1840, 2480), // e
    (390, 1990, 2550),
    (390, 1990, 2550), // i
    (570, 840, 2410),
    (570, 840, 2410), // o
    (440, 1020, 2240),
    (440, 1020, 2240), // u
    (200, 900, 2200),  // b
    (200, 1800, 2600), // c
    (200, 1700, 2600), // d
    (200, 1400, 2200), // f
    (200, 1800, 2300), // g
    (200, 1200, 2500), // h
    (200, 2000, 2700), // j
    (200, 1800, 2400), // k
    (350, 1200, 2600), // l
    (200, 900, 2200),  // m
    (200, 1100, 2400), // n
    (200, 900, 2100),  // p
    (200, 1800, 2400), // q
    (350, 1300, 1700), // r
    (200, 1600, 2600), // s
    (200, 1800, 2600), // t
    (200, 1200, 2200), // v
    (200, 700, 2200),  // w
    (200, 1600, 2600), // x
    (200, 2200, 2800), // y
    (200, 1500, 2500), // z
    (0, 0, 0),         // silence
];

pub struct SamEngine {
    options: SamTTSOptions,
    sample_rate: u32,
}

impl SamEngine {
    pub fn new(options: SamTTSOptions) -> Self {
        Self {
            options: SamTTSOptions {
                speed: options.speed.clamp(20, 200),
                pitch: options.pitch,
                throat: options.throat,
                mouth: options.mouth,
            },
            sample_rate: 22050,
        }
    }

    fn char_to_phonemes(c: char) -> Vec<u8> {
        match c {
            'a' => vec![0, 1],
            'e' => vec![2, 3],
            'i' => vec![4, 5],
            'o' => vec![6, 7],
            'u' => vec![8, 9],
            'b' => vec![10],
            'c' => vec![11],
            'd' => vec![12],
            'f' => vec![13],
            'g' => vec![14],
            'h' => vec![15],
            'j' => vec![16],
            'k' => vec![17],
            'l' => vec![18],
            'm' => vec![19],
            'n' => vec![20],
            'p' => vec![21],
            'q' => vec![22],
            'r' => vec![23],
            's' => vec![24],
            't' => vec![25],
            'v' => vec![26],
            'w' => vec![27],
            'x' => vec![28],
            'y' => vec![29],
            'z' => vec![30],
            ' ' => vec![31],
            '.' | ',' | '!' | '?' | ';' | ':' => vec![31, 31],
            _ if c.is_alphabetic() => vec![0],
            _ => vec![31],
        }
    }

    fn text_to_phonemes(&self, text: &str) -> Vec<u8> {
        text.to_lowercase()
            .chars()
            .flat_map(Self::char_to_phonemes)
            .collect()
    }

    fn synthesize_phoneme(&self, phoneme: u8, duration_ms: u32) -> Vec<f32> {
        let speed_factor = 100.0 / self.options.speed.max(1) as f32;
        let duration_samples =
            (duration_ms as f32 * speed_factor * self.sample_rate as f32 / 1000.0) as usize;

        if duration_samples == 0 {
            return Vec::new();
        }

        let idx = (phoneme as usize).min(FORMANT_FREQUENCIES.len() - 1);
        let (f1, f2, _) = FORMANT_FREQUENCIES[idx];

        let pitch_factor = self.options.pitch as f32 / 64.0;
        let throat_factor = self.options.throat as f32 / 128.0;
        let mouth_factor = self.options.mouth as f32 / 128.0;

        let f1 = (f1 as f32 * pitch_factor * throat_factor) as u16;
        let f2 = (f2 as f32 * pitch_factor * mouth_factor) as u16;

        let fundamental = 80.0 + (self.options.pitch as f32 / 2.0);
        let sample_rate_f = self.sample_rate as f32;

        let mut wave = vec![0.0f32; duration_samples];

        for h in 1..=7 {
            let freq = fundamental * h as f32;
            let amp = 1.0 / h as f32;
            for (i, sample) in wave.iter_mut().enumerate() {
                *sample += amp * (2.0 * PI * freq * i as f32 / sample_rate_f).sin();
            }
        }

        if f1 > 0 {
            for (i, sample) in wave.iter_mut().enumerate() {
                let formant1 = 0.5 * (2.0 * PI * f1 as f32 * i as f32 / sample_rate_f).sin();
                let formant2 = if f2 > 0 {
                    0.3 * (2.0 * PI * f2 as f32 * i as f32 / sample_rate_f).sin()
                } else {
                    0.0
                };
                *sample *= 1.0 + 0.3 * formant1 + formant2;
            }
        }

        let attack = (duration_samples / 10).min(100);
        let release = (duration_samples / 5).min(200);

        for (i, sample) in wave.iter_mut().take(attack).enumerate() {
            *sample *= i as f32 / attack as f32;
        }
        for i in 0..release {
            if duration_samples > release {
                wave[duration_samples - release + i] *= 1.0 - (i as f32 / release as f32);
            }
        }

        let max_val = wave.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        if max_val > 0.0 {
            for sample in &mut wave {
                *sample /= max_val;
            }
        }

        wave
    }

    pub fn synthesize(&self, text: &str) -> Vec<u8> {
        let phonemes = self.text_to_phonemes(text);

        let segments: Vec<Vec<f32>> = phonemes
            .iter()
            .map(|&p| self.synthesize_phoneme(p, 80))
            .filter(|s| !s.is_empty())
            .collect();

        if segments.is_empty() {
            return vec![128; 100];
        }

        let audio: Vec<f32> = segments.into_iter().flatten().collect();

        audio
            .iter()
            .map(|&s| (((s + 1.0) / 2.0) * 255.0) as u8)
            .collect()
    }

    pub fn buf8(&self, text: &str) -> Vec<u8> {
        self.synthesize(text)
    }
}

impl Default for SamEngine {
    fn default() -> Self {
        Self::new(SamTTSOptions::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesizes_text() {
        let engine = SamEngine::default();
        let audio = engine.synthesize("Hello");
        assert!(!audio.is_empty());
        assert!(audio.len() > 100);
    }

    #[test]
    fn applies_options() {
        let slow = SamEngine::new(SamTTSOptions {
            speed: 40,
            ..Default::default()
        });
        let fast = SamEngine::new(SamTTSOptions {
            speed: 120,
            ..Default::default()
        });

        let slow_audio = slow.synthesize("Test");
        let fast_audio = fast.synthesize("Test");

        assert_ne!(slow_audio.len(), fast_audio.len());
    }
}
