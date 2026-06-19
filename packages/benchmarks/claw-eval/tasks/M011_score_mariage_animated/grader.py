from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class ScoreMariageAnimatedGrader(DynamicWebpageGrader):
    REFERENCE_IMAGE_PATH = "fixtures/mariage1.png"
    VISUAL_RUBRIC = (
        "Compare the animated sheet music webpage against the reference Mariage d'Amour score.\n"
        "\n"
        "REFERENCE CONTENT — the score should match these details:\n"
        "Title: 'Mariage d'Amour', Composer: Paul de Senneville\n"
        "Key: g minor (2 flats: Bb, Eb), Time: 4/4→5/4→4/4. 3 measures.\n"
        "M1-2 (4/4): Treble whole rests. Bass: eighth-note arpeggio pairs G2,D3/G3,Bb3/D3,G3/Bb3,D3.\n"
        "M3 (5/4): DRAMATIC ENTRY — treble enters with dense beamed sixteenth notes:\n"
        "  An ascending run D5→Eb5→F5→G5→A5→Bb5→C6→D6, then descending, ending on D5 quarter.\n"
        "  This dense passage is the MOST distinctive visual element.\n"
        "Visual contrast: M1-2 sparse (bass only) → M3 very dense (many beamed sixteenths in treble).\n"
        "\n"
        "SCORING:\n"
        "- M1-M2 treble rests + bass arpeggio? (0.15)\n"
        "- M3 shows dense ascending sixteenth-note run in treble (many beamed notes going UP)? (0.20)\n"
        "- Clear visual contrast between sparse M1-2 and dense M3? (0.15)\n"
        "- Piano keyboard present below score? (0.10)\n"
        "- Play button and note highlight visible? (0.10)\n"
        "- Correct key (2 flats), time signature change, clefs? (0.10)\n"
        "- Layout clean and professional? (0.10)\n"
        "- Title, composer? (0.10)\n"
        "\n"
        "Score LOW if M3 does not show a dense ascending run or M1-M2 are not sparse."
    )
    PHYSICS_RUBRIC = (
        "Score the playback animation across sequential frames ~0.5s apart:\n"
        "- Different notes highlighted in different frames? (0.30)\n"
        "- Piano keys light up corresponding to played notes? (0.25)\n"
        "- Highlight moves left-to-right through the score? (0.20)\n"
        "- Progression speed appears reasonable? (0.15)\n"
        "- Visual change between consecutive frames is clear? (0.10)"
    )
