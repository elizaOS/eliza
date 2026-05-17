from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class ScoreSymphonyAnimatedGrader(DynamicWebpageGrader):
    REFERENCE_IMAGE_PATH = "fixtures/symphony1.png"
    VISUAL_RUBRIC = (
        "Compare the animated sheet music webpage against the reference Symphony No. 5 score.\n"
        "\n"
        "REFERENCE CONTENT — the score should match these details:\n"
        "Title: 'Symphony No. 5 Mvt. 1', Composer: Beethoven, Tempo: 170\n"
        "Key: C minor (3 flats), Time: 2/4. 5 measures.\n"
        "THE FAMOUS 'da-da-da-DUM' MOTIF:\n"
        "  M1: rest + 3 beamed eighth notes on G4 (both staves). Left hand: octave G2+G3.\n"
        "  M2: one half note on Eb4 (HELD, big drop from G). Left: Eb2+Eb3.\n"
        "  M3: rest + 3 beamed eighth notes on F4 (LOWER than M1). Left: F2+F3.\n"
        "  M4: one half note on D4, tied to M5. Left: D2+D3.\n"
        "Pattern: rest+3notes, HOLD, rest+3notes, HOLD — the motif steps DOWN (G→Eb, F→D).\n"
        "Both staves mirror the same rhythm.\n"
        "\n"
        "SCORING:\n"
        "- Is rest + 3 beamed notes pattern visible in M1 and M3? (0.20)\n"
        "- Are M2 and M4 held half notes (short-short-short-LONG rhythm)? (0.15)\n"
        "- Do M1 notes sit higher than M3 (G vs F, stepping down)? (0.10)\n"
        "- Both staves mirror same pattern? (0.05)\n"
        "- Piano keyboard present below score? (0.10)\n"
        "- Play button and note highlight visible? (0.10)\n"
        "- Correct key (3 flats), time (2/4), ties M4-M5? (0.10)\n"
        "- Layout clean, title, composer? (0.10)\n"
        "- Overall visual match to reference? (0.10)\n"
        "\n"
        "Score LOW if the da-da-da-DUM pattern is not recognizable."
    )
    PHYSICS_RUBRIC = (
        "Score the playback animation across sequential frames ~0.5s apart:\n"
        "- Different notes highlighted in different frames? (0.30)\n"
        "- Piano keys light up corresponding to played notes? (0.25)\n"
        "- Highlight moves left-to-right through the score? (0.20)\n"
        "- Progression speed appears reasonable? (0.15)\n"
        "- Visual change between consecutive frames is clear? (0.10)"
    )
