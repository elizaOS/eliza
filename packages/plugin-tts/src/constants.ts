export const FAL_CONSTANTS = {
    API_TTS_ENDPOINT: "fal-ai/playai/tts/v3",
    API_KEY_SETTING: "FAL_API_KEY", // The setting name to fetch from runtime
};

export interface VoiceOption {
    name: string;
    style: "Conversational" | "Narrative" | "Advertising" | "Meditation";
    region?: string;
    fullName: string; 
  }

export const VOICE_MAP: Record<string, VoiceOption[]> = {
    'en': [
    { 
    name: "Jennifer", 
    style: "Conversational", 
    region: "US/American",
    fullName: "Jennifer (English (US)/American)"
    },
    { 
    name: "Dexter", 
    style: "Conversational", 
    region: "US/American",
    fullName: "Dexter (English (US)/American)"
    },
    { 
    name: "Ava", 
    style: "Conversational", 
    region: "AU/Australian",
    fullName: "Ava (English (AU)/Australian)"
    },
    { 
    name: "Tilly", 
    style: "Conversational", 
    region: "AU/Australian",
    fullName: "Tilly (English (AU)/Australian)"
    },
    { 
    name: "Charlotte", 
    style: "Advertising", 
    region: "CA/Canadian",
    fullName: "Charlotte (Advertising) (English (CA)/Canadian)"
    },
    { 
    name: "Charlotte", 
    style: "Meditation", 
    region: "CA/Canadian",
    fullName: "Charlotte (Meditation) (English (CA)/Canadian)"
    },
    { 
    name: "Cecil", 
    style: "Conversational", 
    region: "GB/British",
    fullName: "Cecil (English (GB)/British)"
    },
    { 
    name: "Sterling", 
    style: "Conversational", 
    region: "GB/British",
    fullName: "Sterling (English (GB)/British)"
    },
    { 
    name: "Cillian", 
    style: "Conversational", 
    region: "IE/Irish",
    fullName: "Cillian (English (IE)/Irish)"
    },
    { 
    name: "Madison", 
    style: "Conversational", 
    region: "IE/Irish",
    fullName: "Madison (English (IE)/Irish)"
    },
    { 
    name: "Ada", 
    style: "Conversational", 
    region: "ZA/South african",
    fullName: "Ada (English (ZA)/South african)"
    },
    { 
    name: "Sumita", 
    style: "Conversational", 
    region: "IN/Indian",
    fullName: "Sumita (English (IN)/Indian)"
    },
    { 
    name: "Navya", 
    style: "Conversational", 
    region: "IN/Indian",
    fullName: "Navya (English (IN)/Indian)"
    }
        ],
    'ja': [
    { 
    name: "Kiriko", 
    style: "Conversational", 
    region: "Japanese",
    fullName: "Kiriko Conversational (Japanese/Japanese)"
    },
    { 
    name: "Kiriko", 
    style: "Narrative", 
    region: "Japanese",
    fullName: "Kiriko Narrative (Japanese/Japanese)"
    }
        ],
    'af': [
    { 
    name: "Ronel", 
    style: "Conversational", 
    region: "South african",
    fullName: "Ronel Conversational (Afrikaans/South african)"
    },
    { 
    name: "Ronel", 
    style: "Narrative", 
    region: "South african",
    fullName: "Ronel Narrative (Afrikaans/South african)"
    }
        ],
    'ar': [
    { 
    name: "Abdo", 
    style: "Conversational", 
    region: "Arabic",
    fullName: "Abdo Conversational (Arabic/Arabic)"
    },
    { 
    name: "Abdo", 
    style: "Narrative", 
    region: "Arabic",
    fullName: "Abdo Narrative (Arabic/Arabic)"
    }
        ],
    'bn': [
    { 
    name: "Mousmi", 
    style: "Conversational", 
    region: "Bengali",
    fullName: "Mousmi Conversational (Bengali/Bengali)"
    },
    { 
    name: "Mousmi", 
    style: "Narrative", 
    region: "Bengali",
    fullName: "Mousmi Narrative (Bengali/Bengali)"
    }
        ],
    'pt': [
    { 
    name: "Caroline", 
    style: "Conversational", 
    region: "Brazilian",
    fullName: "Caroline Conversational (Portuguese (BR)/Brazilian)"
    },
    { 
    name: "Caroline", 
    style: "Narrative", 
    region: "Brazilian", 
    fullName: "Caroline Narrative (Portuguese (BR)/Brazilian)"
    }
        ],
    'fr': [
    { 
    name: "Ange", 
    style: "Conversational", 
    region: "French",
    fullName: "Ange Conversational (French/French)"
    },
    { 
    name: "Ange", 
    style: "Narrative", 
    region: "French",
    fullName: "Ange Narrative (French/French)"
    },
    { 
    name: "Baptiste", 
    style: "Conversational", 
    region: "French",
    fullName: "Baptiste (English (FR)/French)"
    }
        ],
    'de': [
        { 
            name: "Anke", 
            style: "Conversational", 
            region: "German",
            fullName: "Anke Conversational (German/German)"
        },
        { 
            name: "Anke", 
            style: "Narrative", 
            region: "German",
            fullName: "Anke Narrative (German/German)"
        }
        ],
    'es': [
        { 
            name: "Carmen", 
            style: "Conversational", 
            region: "Spanish",
            fullName: "Carmen Conversational (Spanish/Spanish)"
        },
        { 
            name: "Patricia", 
            style: "Conversational", 
            region: "Spanish",
            fullName: "Patricia Conversational (Spanish/Spanish)"
        }
        ],
    'ko': [
        { 
            name: "Dohee", 
            style: "Conversational", 
            region: "Korean",
            fullName: "Dohee Conversational (Korean/Korean)"
        },
        { 
            name: "Dohee", 
            style: "Narrative", 
            region: "Korean",
            fullName: "Dohee Narrative (Korean/Korean)"
        }
        ],
    'he': [
    { 
      name: "Mary", 
      style: "Conversational", 
      region: "Israeli",
      fullName: "Mary Conversational (Hebrew/Israeli)"
    },
    { 
      name: "Mary", 
      style: "Narrative", 
      region: "Israeli",
      fullName: "Mary Narrative (Hebrew/Israeli)"
    }
    ],
    'id': [
    { 
      name: "Ignatius", 
      style: "Conversational", 
      region: "Malay",
      fullName: "Ignatius Conversational (Malay/Malay)"
    },
    { 
      name: "Ignatius", 
      style: "Narrative", 
      region: "Malay",
      fullName: "Ignatius Narrative (Malay/Malay)"
    }
    ],
    'ru': [
        { 
          name: "Andrei", 
          style: "Conversational", 
          region: "Russian",
          fullName: "Andrei Conversational (Russian/Russian)"
        },
        { 
          name: "Andrei", 
          style: "Narrative", 
          region: "Russian",
          fullName: "Andrei Narrative (Russian/Russian)"
        }
      ],
    'tl': [
        { 
          name: "Aiken", 
          style: "Conversational", 
          region: "Filipino",
          fullName: "Aiken Conversational (Tagalog/Filipino)"
        },
        { 
          name: "Aiken", 
          style: "Narrative", 
          region: "Filipino",
          fullName: "Aiken Narrative (Tagalog/Filipino)"
        }
      ],
    'mk': [
    { 
        name: "Aleksa", 
        style: "Conversational", 
        region: "Serbian",
        fullName: "Aleksa Conversational (Serbian/Serbian)"
    },
    { 
        name: "Aleksa", 
        style: "Narrative", 
        region: "Serbian",
        fullName: "Aleksa Narrative (Serbian/Serbian)"
    }
    ],
    'ne': [
    { 
        name: "Anuj", 
        style: "Conversational", 
        region: "Indian",
        fullName: "Anuj Conversational (Hindi/Indian)"
    },
    { 
        name: "Anuj", 
        style: "Narrative", 
        region: "Indian",
        fullName: "Anuj Narrative (Hindi/Indian)"
    }
    ],
    'th': [
        { 
          name: "Katbundit", 
          style: "Conversational", 
          region: "Thai",
          fullName: "Katbundit Conversational (Thai/Thai)"
        },
        { 
          name: "Katbundit", 
          style: "Narrative", 
          region: "Thai",
          fullName: "Katbundit Narrative (Thai/Thai)"
        }
      ],
    'tr': [
    { 
        name: "Ali", 
        style: "Conversational", 
        region: "Turkish",
        fullName: "Ali Conversational (Turkish/Turkish)"
    },
    { 
        name: "Ali", 
        style: "Narrative", 
        region: "Turkish",
        fullName: "Ali Narrative (Turkish/Turkish)"
    }
    ],
};

export const getRandomVoice = (voiceOptions: VoiceOption[]): VoiceOption => {
    const randomIndex = Math.floor(Math.random() * voiceOptions.length);
    return voiceOptions[randomIndex];
  };
