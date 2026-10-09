from PIL import Image


def pad_to_square(image: Image.Image,
                  fill_color=(0, 0, 0),
                  padding: int = 0) -> Image.Image:
    """
    First make it a square, then expand the padding pixels around it.
    """
    width, height = image.size
    if width == height:
        square_img = image.copy()
    else:
        new_size = max(width, height)
        square_img = Image.new(image.mode, (new_size, new_size), fill_color)
        left = (new_size - width) // 2
        top = (new_size - height) // 2
        square_img.paste(image, (left, top))

    if padding > 0:
        final_size = square_img.size[0] + 2 * padding
        padded_img = Image.new(square_img.mode, (final_size, final_size),
                               fill_color)
        padded_img.paste(square_img, (padding, padding))
        return padded_img
    else:
        return square_img
