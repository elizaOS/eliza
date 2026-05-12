import math


def round_by_factor(number: int, factor: int) -> int:
    """返回最接近 number 的且能被 factor 整除的整数"""
    return round(number / factor) * factor


def ceil_by_factor(number: int, factor: int) -> int:
    """返回大于等于 number 的且能被 factor 整除的整数"""
    return math.ceil(number / factor) * factor


def floor_by_factor(number: int, factor: int) -> int:
    """返回小于等于 number 的且能被 factor 整除的整数"""
    return math.floor(number / factor) * factor


def smart_resize(height, width, factor=28, min_pixels=56 * 56, max_pixels=14 * 14 * 4 * 1280, max_long_side=8192):
    """缩放后图片满足以下条件:
    1. 长宽能被 factor 整除
    2. pixels 总数被限制在 [min_pixels, max_pixels] 内
    3. 最长边限制在 max_long_side 内
    4. 保证其长宽比基本不变
    """
    if height < 2 or width < 2:
        raise ValueError(f"height:{height} or width:{width} must be larger than factor:{factor}")
    elif max(height, width) / min(height, width) > 200:
        raise ValueError(f"absolute aspect ratio must be smaller than 100, got {height} / {width}")

    if max(height, width) > max_long_side:
        beta = max(height, width) / max_long_side
        height, width = int(height / beta), int(width / beta)

    h_bar = round_by_factor(height, factor)
    w_bar = round_by_factor(width, factor)
    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = floor_by_factor(height / beta, factor)
        w_bar = floor_by_factor(width / beta, factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar = ceil_by_factor(height * beta, factor)
        w_bar = ceil_by_factor(width * beta, factor)
    return h_bar, w_bar


def update_image_size_(image_ele: dict, min_tokens=1, max_tokens=12800, merge_base=2, patch_size=14):
    """根据 min_tokens, max_tokens 更新 image_ele 的尺寸信息

    Args:
        image_ele (dict):
            - image_ele["image"]: str 图片路径
            - image_ele["height"]: int 图片原始高度
            - image_ele["width"]: int 图片原始宽度

    Returns:
        更新后的 image_ele, 新增如下 key-value pair
        dict:
            - image_ele["resized_height"]: int 输入到模型的真实高度
            - image_ele["resized_width"]: int 输入到模型的真实宽度
            - image_ele["seq_len"]: int 输入到模型所占的序列长度
    """
    height, width = image_ele["height"], image_ele["width"]
    pixels_per_token = patch_size * patch_size * merge_base * merge_base
    resized_height, resized_width = smart_resize(
        height,
        width,
        factor=merge_base * patch_size,
        min_pixels=pixels_per_token * min_tokens,
        max_pixels=pixels_per_token * max_tokens,
        max_long_side=50000,
    )
    image_ele.update(
        {
            "resized_height": resized_height,
            "resized_width": resized_width,
            "seq_len": resized_height * resized_width // pixels_per_token + 2,
        }
    )
    return image_ele


def _convert_bbox_format_from_abs_origin(bbox, image_ele: dict, *, tgt_format: str):
    x1, y1, x2, y2 = bbox
    if tgt_format == "abs_origin":
        new_bbox = [int(x1), int(y1), int(x2), int(y2)]
    elif tgt_format == "abs_resized":
        new_bbox = [
            int(x1 / image_ele["width"] * image_ele["resized_width"]),
            int(y1 / image_ele["height"] * image_ele["resized_height"]),
            int(x2 / image_ele["width"] * image_ele["resized_width"]),
            int(y2 / image_ele["height"] * image_ele["resized_height"]),
        ]
    elif tgt_format == "qwen-vl":
        new_bbox = [
            int(x1 / image_ele["width"] * 999),
            int(y1 / image_ele["height"] * 999),
            int(x2 / image_ele["width"] * 999),
            int(y2 / image_ele["height"] * 999),
        ]
    elif tgt_format == "rel":
        new_bbox = [
            float(x1 / image_ele["width"]),
            float(y1 / image_ele["height"]),
            float(x2 / image_ele["width"]),
            float(y2 / image_ele["height"]),
        ]
    elif tgt_format == "molmo":
        new_bbox = [
            round(x1 / image_ele["width"] * 100, ndigits=1),
            round(y1 / image_ele["height"] * 100, ndigits=1),
            round(x2 / image_ele["width"] * 100, ndigits=1),
            round(y2 / image_ele["height"] * 100, ndigits=1),
        ]
    else:
        assert False, f"Unknown tgt_format: {tgt_format}"
    return new_bbox


def _convert_bbox_format_to_abs_origin(bbox, image_ele: dict, *, src_format: str):
    x1, y1, x2, y2 = bbox
    if src_format == "abs_origin":
        new_bbox = [int(x1), int(y1), int(x2), int(y2)]
    elif src_format == "abs_resized":
        new_bbox = [
            int(x1 / image_ele["resized_width"] * image_ele["width"]),
            int(y1 / image_ele["resized_height"] * image_ele["height"]),
            int(x2 / image_ele["resized_width"] * image_ele["width"]),
            int(y2 / image_ele["resized_height"] * image_ele["height"]),
        ]
    elif src_format == "qwen-vl":
        new_bbox = [
            int(x1 / 999 * image_ele["width"]),
            int(y1 / 999 * image_ele["height"]),
            int(x2 / 999 * image_ele["width"]),
            int(y2 / 999 * image_ele["height"]),
        ]
    elif src_format == "rel":
        new_bbox = [
            int(x1 * image_ele["width"]),
            int(y1 * image_ele["height"]),
            int(x2 * image_ele["width"]),
            int(y2 * image_ele["height"]),
        ]
    elif src_format == "molmo":
        new_bbox = [
            int(x1 / 100 * image_ele["width"]),
            int(y1 / 100 * image_ele["height"]),
            int(x2 / 100 * image_ele["width"]),
            int(y2 / 100 * image_ele["height"]),
        ]
    else:
        assert False, f"Unknown src_format: {src_format}"
    return new_bbox


def convert_bbox_format(bbox, image_ele: dict, *, src_format: str, tgt_format: str):
    bbox_abs_origin = _convert_bbox_format_to_abs_origin(bbox, image_ele, src_format=src_format)
    bbox_tgt_format = _convert_bbox_format_from_abs_origin(bbox_abs_origin, image_ele, tgt_format=tgt_format)
    return bbox_tgt_format


def _convert_point_format_from_abs_origin(point, image_ele: dict, *, tgt_format: str):
    x, y = point
    if tgt_format == "abs_origin":
        new_point = [int(x), int(y)]
    elif tgt_format == "abs_resized":
        new_point = [
            int(x / image_ele["width"] * image_ele["resized_width"]),
            int(y / image_ele["height"] * image_ele["resized_height"]),
        ]
    elif tgt_format == "qwen-vl":
        new_point = [
            int(x / image_ele["width"] * 999),
            int(y / image_ele["height"] * 999),
        ]
    elif tgt_format == "rel":
        new_point = [
            float(x / image_ele["width"]),
            float(y / image_ele["height"]),
        ]
    elif tgt_format == "molmo":
        new_point = [
            round(x / image_ele["width"] * 100, ndigits=1),
            round(y / image_ele["height"] * 100, ndigits=1),
        ]
    else:
        assert False, f"Unknown tgt_format: {tgt_format}"
    return new_point


def _convert_point_format_to_abs_origin(point, image_ele: dict, *, src_format: str):
    x, y = point
    if src_format == "abs_origin":
        new_point = [int(x), int(y)]
    elif src_format == "abs_resized":
        new_point = [
            int(x / image_ele["resized_width"] * image_ele["width"]),
            int(y / image_ele["resized_height"] * image_ele["height"]),
        ]
    elif src_format == "qwen-vl":
        new_point = [
            int(x / 999 * image_ele["width"]),
            int(y / 999 * image_ele["height"]),
        ]
    elif src_format == "rel":
        new_point = [
            int(x * image_ele["width"]),
            int(y * image_ele["height"]),
        ]
    elif src_format == "molmo":
        new_point = [
            int(x / 100 * image_ele["width"]),
            int(y / 100 * image_ele["height"]),
        ]
    else:
        assert False, f"Unknown src_format: {src_format}"
    return new_point


def convert_point_format(point, image_ele: dict, *, src_format: str, tgt_format: str):
    point_abs_origin = _convert_point_format_to_abs_origin(point, image_ele, src_format=src_format)
    point_tgt_format = _convert_point_format_from_abs_origin(point_abs_origin, image_ele, tgt_format=tgt_format)
    return point_tgt_format


__all__ = [
    "update_image_size_",
    "convert_bbox_format",
    "convert_point_format",
]


if __name__ == "__main__":
    from PIL import Image

    def draw_point(image: Image.Image, point: list):
        from copy import deepcopy

        from PIL import ImageDraw

        image = deepcopy(image)
        image_draw = ImageDraw.Draw(image)
        image_draw.ellipse([point[0] - 5, point[1] - 5, point[0] + 5, point[1] + 5], fill="red")
        return image

    # image_ele = {
    #     "image": "http://ofasys-multimodal-wlcb-3.oss-cn-wulanchabu.aliyuncs.com/data/datacomp1b/image/19774238/7218d7ceb39e82e0cafc389f326e218da623a8f2.jpg",
    #     "height": 444,
    #     "width": 592,
    # }
    image_ele = {
        "image": "46d5402b2c183f996f2a13cd2016af15.png",
        "height": 1080,
        "width": 1920,
    }
    point = [0.8379917184, 0.2087912088]  # rel, keyboard 'k' in the image

    # image: Image.Image = Image.open(requests.get(image_ele["image"], stream=True).raw)
    image: Image.Image = Image.open(image_ele["image"])
    assert image.width == image_ele["width"] and image.height == image_ele["height"], f"{image.size=}, {image_ele=}"
    resized_image = image.resize((image_ele["resized_width"], image_ele["resized_height"]))
    draw_point(image, [point[0] * image.width, point[1] * image.height]).save("image_1.png")

    image_ele = update_image_size_(image_ele)
    point = convert_point_format(point, image_ele, src_format="rel", tgt_format="abs_resized")
    print(f"{image_ele=}\n{point=}")

    
    draw_point(resized_image, point).save("image_2.png")