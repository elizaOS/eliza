from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class ScoreCanonAnimatedGrader(DynamicWebpageGrader):
    REFERENCE_IMAGE_PATH = "fixtures/Canon1.png"
    VISUAL_RUBRIC = (
        "Compare the animated sheet music webpage against the reference Canon in D score.\n"
        "\n"
        "REFERENCE CONTENT — the score should match these details:\n"
        "Title: 'Canon in D', Key: D Major (2 sharps), Time: 4/4, Tempo: 100\n"
        "8 measures: M1-4 bass solo (treble rests), M5-8 melody enters.\n"
        "Bass (M1-4): eighth-note pairs forming arpeggios — each measure at DIFFERENT heights:\n"
        "  M1: D3,F#3 / A3,D4 / A2,C#3 / E3,A3\n"
        "  M2: B2,D3 / F#3,B3 / F#2,A2 / C#3,F#3\n"
        "  M3: G2,B2 / D3,G3 / D3,F#3 / A3,D4\n"
        "  M4: G2,B2 / D3,G3 / A2,C#3 / E3,A3\n"
        "Treble (M5-8): half notes descending then rising: F#5,E5,D5,C#5,B4,A4,B4,C#5\n"
        "\n"
        "SCORING:\n"
        "- Do bass notes vary per measure (not a flat repeated pattern)? (0.20)\n"
        "- Does treble rest in M1-4 and enter with descending half notes in M5+? (0.15)\n"
        "- Note positions on staff match reference? (0.15)\n"
        "- Piano keyboard present below score? (0.10)\n"
        "- Play button and note highlight/playback indicator visible? (0.10)\n"
        "- Correct key (2 sharps), time (4/4), clefs? (0.10)\n"
        "- Layout clean and professional? (0.10)\n"
        "- Title, composer, dynamics? (0.10)\n"
        "\n"
        "Score LOW if bass is flat repeated pattern or treble notes in M1-4."
    )
    PHYSICS_RUBRIC = (
        "Score the Canon playback animation across sequential frames ~0.5s apart:\n"
        "- Different notes highlighted in different frames? (0.30)\n"
        "- Piano keys light up corresponding to played notes? (0.25)\n"
        "- Highlight moves left-to-right through the score? (0.20)\n"
        "- Progression speed appears reasonable? (0.15)\n"
        "- Visual change between consecutive frames is clear? (0.10)"
    )
