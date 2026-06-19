"""
Turtle-based Doraemon drawing example.
This script demonstrates basic turtle graphics for drawing circles.
"""

import turtle

# TODO: finish Doraemon drawing

def draw_circle(t, x, y, radius, color):
    """Draw a filled circle at the given position."""
    t.penup()
    t.goto(x, y - radius)
    t.pendown()
    t.fillcolor(color)
    t.begin_fill()
    t.circle(radius)
    t.end_fill()


def main():
    screen = turtle.Screen()
    screen.setup(800, 800)
    screen.title("Doraemon - Turtle Example")

    t = turtle.Turtle()
    t.speed(0)
    t.hideturtle()

    # Draw a blue circle (head placeholder)
    draw_circle(t, 0, 50, 200, "#0093D6")

    # Draw a red circle (nose placeholder)
    draw_circle(t, 0, -10, 15, "#D63C3C")

    # TODO: Add face, eyes, whiskers, mouth, body, collar, bell
    # TODO: Add save-to-file functionality
    # NOTE: turtle cannot directly save to PNG; need EPS -> PNG conversion

    screen.mainloop()


if __name__ == "__main__":
    main()
