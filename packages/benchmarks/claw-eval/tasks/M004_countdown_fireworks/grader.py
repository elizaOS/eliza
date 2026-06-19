from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class CountdownFireworksGrader(DynamicWebpageGrader):
    VISUAL_RUBRIC = (
        "Score the generated countdown + fireworks webpage screenshots:\n"
        "- Dark background visible? (0.10)\n"
        "- Countdown number or 'Happy New Year!' message visible? (0.25)\n"
        "- Firework particles/explosions visible (colorful bursts)? (0.25)\n"
        "- Multiple firework colors used? (0.15)\n"
        "- Clean, centered layout? (0.10)\n"
        "- Overall visual appeal and polish? (0.15)"
    )
    PHYSICS_RUBRIC = (
        "Score the countdown/fireworks animation across sequential frames ~0.5s apart:\n"
        "- Countdown numbers decrease across early frames? (0.25)\n"
        "- Fireworks appear after countdown ends? (0.25)\n"
        "- Particles spread outward from explosion points? (0.20)\n"
        "- Multiple firework bursts at different positions? (0.15)\n"
        "- 'Happy New Year!' message appears after countdown? (0.15)"
    )
