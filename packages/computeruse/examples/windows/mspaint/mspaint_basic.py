import asyncio
import computeruse
import os
import platform
import enum


def is_windows_11():
    version = platform.version()
    return platform.system() == "Windows" and int(version.split(".")[2]) >= 22000


class Shape(enum.Enum):
    ROUNDED_RECTANGLE = "Rounded rectangle"
    TRIANGLE = "Triangle"
    RIGHT_TRIANGLE = "Right triangle"
    RECTANGLE = "Rectangle"
    OVAL = "Oval"
    LINE = "Line"
    CURVE = "Curve"
    POLYGON = "Polygon"
    DIAMOND = "Diamond"
    PENTAGON = "Pentagon"
    HEXAGON = "Hexagon"
    RIGHT_ARROW = "Right arrow"
    LEFT_ARROW = "Left arrow"
    UP_ARROW = "Up arrow"
    DOWN_ARROW = "Down arrow"
    FOUR_POINT_STAR = "Four-point star"
    FIVE_POINT_STAR = "Five-point star"
    SIX_POINT_STAR = "Six-point star"
    ROUNDED_RECTANGULAR_CALLOUT = "Rounded rectangular callout"
    OVAL_CALLOUT = "Oval callout"
    CLOUD_CALLOUT = "Cloud callout"
    HEART = "Heart"
    LIGHTNING = "Lightning"

    def get_platform_name(self):
        if self == Shape.RIGHT_TRIANGLE:
            return "Right triangle" if is_windows_11() else "Right-angled triangle"
        return self.value


class Brush(enum.Enum):
    BRUSH = "Brush"
    CALLIGRAPHY_BRUSH = "Calligraphy brush"
    CALLIGRAPHY_PEN = "Calligraphy pen"
    AIRBRUSH = "Airbrush"
    OIL_BRUSH = "Oil brush"
    CRAYON = "Crayon"
    MARKER = "Marker"
    NATURAL_PENCIL = "Natural pencil"
    WATERCOLOUR_BRUSH = "Watercolour brush"

    def get_platform_name(self):
        if self == Brush.CALLIGRAPHY_BRUSH:
            return "Calligraphy brush" if is_windows_11() else "Calligraphy brush 1"
        if self == Brush.CALLIGRAPHY_PEN:
            return "Calligraphy pen" if is_windows_11() else "Calligraphy brush 2"
        return self.value


async def select_shape(shape: Shape, paint_window, desktop):
    """
    Select a shape tool by its name from the Shapes toolbar.
    Only valid shape names from the Shape enum are allowed.
    """
    shape_name = shape.get_platform_name()
    print(f"Selecting shape tool: {shape_name}")
    if is_windows_11():
        shapes_box = paint_window.locator("Group:Shapes").locator("role:List")
        tool = await shapes_box.locator(f"Button:{shape_name}").first()
    else:
        more_shapes_button = await (
            paint_window.locator("Pane:UIRibbonDockTop")
            .locator("Pane:Lower Ribbon")
            .locator("Name:Shapes")
            .locator("Group:Shapes")
            .locator("Button:Shapes")
            .first()
        )
        more_shapes_button.click()
        await asyncio.sleep(0.2)
        shapes_box = desktop.locator("window:Shapes").locator("List:Shapes")
        tool = await shapes_box.locator(f"Name:{shape_name}").first()
    tool.click()
    await asyncio.sleep(0.5)


async def select_brush(brush: Brush, paint_window, desktop):
    """
    Select a brush tool by its name from the Brushes window.
    Only valid brush names from the Brush enum are allowed.
    """
    brush_name = brush.get_platform_name()
    print(f"Selecting brush: {brush_name}")
    # Open the Brushes dropdown
    if is_windows_11():
        brushes_button = await (
            paint_window.locator("Group:Brushes").locator("Name:Brushes").first()
        )
        brushes_button.perform_action("expand_collapse")
        brushes_group = paint_window.locator("role:Menu")
        brush_elem = await (
            brushes_group.locator(f"Name:{brush_name}").locator("role:Image").first()
        )
    else:
        tool_panel = paint_window.locator("Pane:UIRibbonDockTop").locator(
            "Pane:Lower Ribbon"
        )
        brushes_button = await (
            tool_panel.locator("Name:Brushes").locator("Button:Brushes").first()
        )
        brushes_button.click()
        await asyncio.sleep(0.5)
        brushes_group = desktop.locator("List:Brushes")
        brush_elem = await brushes_group.locator(f"Name:{brush_name}").first()
    brush_elem.click()
    await asyncio.sleep(0.5)


async def save_as_dialog(paint_window, file_path):
    """
    Open the Save As dialog in Paint and save the file to the specified file_path.
    Handles overwrite confirmation if the file already exists.
    """
    print("Opening Save As dialog...")
    paint_window.press_key("{Ctrl}s")
    await asyncio.sleep(1)

    print("Entering file name...")
    save_dialog = paint_window.locator("window:Save As")
    file_name_edit_box = await (
        save_dialog.locator("role:Pane")
        .locator("role:ComboBox")
        .locator("role:Edit")
        .first()
    )
    file_name_edit_box.type_text(file_path)
    file_already_exists = os.path.exists(file_path)

    # Find and click the Save button
    save_button = await save_dialog.locator("Button:Save").first()
    save_button.click()

    print("save button clicked")

    # Handle the confirmation dialog if file exists
    if file_already_exists:
        confirm_overwrite = await (
            save_dialog.locator("Window:Confirm Save As").locator("Button:Yes").first()
        )
        confirm_overwrite.click()
        print("confirm overwrite clicked")

    print("File saved successfully!")


async def run_mspaint():
    desktop = computeruse.Desktop(log_level="error")
    try:
        print("Opening Microsoft Paint...")
        paint_window = desktop.open_application("mspaint.exe")
        await asyncio.sleep(0.5)
        paint_window.maximize_window()

        # The following selectors may need adjustment depending on Paint version
        # Try to locate the canvas
        canvas = await paint_window.locator("Name:Canvas").first()
        canvas_bounds = canvas.bounds()
        print(f"Canvas bounds: {canvas_bounds}")

        if is_windows_11():
            print("Zooming in...")
            paint_window.press_key("{Ctrl}1")
            paint_window.press_key("{Ctrl}+")
            await asyncio.sleep(0.5)

        # Draw shapes
        await select_shape(Shape.ROUNDED_RECTANGLE, paint_window, desktop)
        if is_windows_11():
            canvas.mouse_drag(280, 280, 530, 530)
        else:
            canvas.mouse_drag(200, 200, 450, 450)

        await select_shape(Shape.TRIANGLE, paint_window, desktop)
        if is_windows_11():
            canvas.mouse_drag(305, 305, 505, 505)
        else:
            canvas.mouse_drag(225, 225, 425, 425)

        # Select the pencil tool
        # pencil = await paint_window.locator('Name:Tools').locator('Name:Pencil').first()
        # pencil.click()

        await select_brush(Brush.CALLIGRAPHY_BRUSH, paint_window, desktop)

        # Draw the word COMPUTERUSE in block letters
        start_x = 580 if is_windows_11() else 460
        start_y = 400 if is_windows_11() else 280
        letter_width = 60
        letter_height = 40
        spacing = 10
        x = start_x
        y = start_y

        # T
        canvas.mouse_drag(x + 0.0 * letter_width, y, x + 1.0 * letter_width, y)
        canvas.mouse_drag(
            x + 0.5 * letter_width, y, x + 0.5 * letter_width, y + letter_height
        )
        x += letter_width + spacing

        # E
        canvas.mouse_drag(x, y, x, y + letter_height)
        canvas.mouse_drag(x, y, x + letter_width, y)
        canvas.mouse_drag(
            x, y + letter_height / 2, x + letter_width * 0.8, y + letter_height / 2
        )
        canvas.mouse_drag(x, y + letter_height, x + letter_width, y + letter_height)
        x += letter_width + spacing

        # R
        canvas.mouse_drag(x, y, x, y + letter_height)
        canvas.mouse_drag(x, y, x + letter_width * 0.7, y)
        canvas.mouse_drag(
            x, y + letter_height / 2, x + letter_width * 0.7, y + letter_height / 2
        )
        canvas.mouse_drag(
            x + letter_width * 0.7, y, x + letter_width * 0.7, y + letter_height / 2
        )
        canvas.mouse_drag(x, y + letter_height / 2, x + letter_width, y + letter_height)
        x += letter_width + spacing

        # M
        canvas.mouse_drag(x, y + letter_height, x, y)
        canvas.mouse_drag(x, y, x + letter_width / 2, y + letter_height / 2)
        canvas.mouse_drag(
            x + letter_width / 2, y + letter_height / 2, x + letter_width, y
        )
        canvas.mouse_drag(x + letter_width, y, x + letter_width, y + letter_height)
        x += letter_width + spacing

        # I
        canvas.mouse_drag(
            x + letter_width / 2, y, x + letter_width / 2, y + letter_height
        )
        x += letter_width + spacing

        # N
        canvas.mouse_drag(x, y + letter_height, x, y)
        canvas.mouse_drag(x, y, x + letter_width, y + letter_height)
        canvas.mouse_drag(x + letter_width, y + letter_height, x + letter_width, y)
        x += letter_width + spacing

        # A
        canvas.mouse_drag(x + letter_width / 2, y, x, y + letter_height)
        canvas.mouse_drag(x + letter_width / 2, y, x + letter_width, y + letter_height)
        canvas.mouse_drag(
            x + letter_width * 0.25,
            y + letter_height * 0.6,
            x + letter_width * 0.75,
            y + letter_height * 0.6,
        )
        x += letter_width + spacing

        # T
        canvas.mouse_drag(x, y, x + letter_width, y)
        canvas.mouse_drag(
            x + letter_width / 2, y, x + letter_width / 2, y + letter_height
        )
        x += letter_width + spacing

        # O
        canvas.mouse_drag(x, y, x + letter_width, y)
        canvas.mouse_drag(x, y + letter_height, x + letter_width, y + letter_height)
        canvas.mouse_drag(x, y, x, y + letter_height)
        canvas.mouse_drag(x + letter_width, y, x + letter_width, y + letter_height)
        x += letter_width + spacing

        # R
        canvas.mouse_drag(x, y, x, y + letter_height)
        canvas.mouse_drag(x, y, x + letter_width * 0.7, y)
        canvas.mouse_drag(
            x, y + letter_height / 2, x + letter_width * 0.7, y + letter_height / 2
        )
        canvas.mouse_drag(
            x + letter_width * 0.7, y, x + letter_width * 0.7, y + letter_height / 2
        )
        canvas.mouse_drag(x, y + letter_height / 2, x + letter_width, y + letter_height)
        x += letter_width + spacing

        # Open Save As dialog
        home_dir = os.path.expanduser("~")
        file_path = os.path.join(home_dir, "computeruse_paint_test.png")
        await save_as_dialog(paint_window, file_path)

    except computeruse.PlatformError as e:
        print(f"Platform Error: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")


if __name__ == "__main__":
    asyncio.run(run_mspaint())
