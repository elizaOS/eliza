from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class WorldClockGrader(DynamicWebpageGrader):
    VISUAL_RUBRIC = (
        "Score the generated world clock webpage screenshots:\n"
        "- Four distinct clock faces visible? (0.25)\n"
        "- Each clock labeled with city name (北京, London, New York, Tokyo)? (0.20)\n"
        "- Clocks arranged in clean horizontal/grid layout? (0.15)\n"
        "- Each clock has hands (hour/minute/second)? (0.20)\n"
        "- Distinct colors per clock, overall clean design? (0.20)"
    )
    PHYSICS_RUBRIC = (
        "Score the world clock animation across sequential frames ~0.5s apart:\n"
        "- Second hands move between frames on all clocks? (0.30)\n"
        "- Different clocks show different times (timezone offsets)? (0.25)\n"
        "- Movement is smooth and clockwise? (0.20)\n"
        "- Clocks remain synchronized (all updating each frame)? (0.15)\n"
        "- Overall animation looks natural? (0.10)"
    )
