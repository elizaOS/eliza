#!/usr/bin/env python3

"""
Library for counting number of objects in the image using pixel level normalized
correlation coefficient method.

Example usage:
    $ python3 scripts/count_objects.py \
        --tool count \
        --input_image ./abc.png \
        --object_image ./obj.png \
        --threshold 0.9 \
        --dedup_min_dist 3

Sample output:
    There are 2 objects (`./obj.png`) in file: `./abc.png`
"""

import argparse

import cv2 as cv
import numpy as np


def get_args():
    parser = argparse.ArgumentParser("a set of image processing tools")
    parser.add_argument(
        "--tool",
        type=str,
        choices=["denoise", "super_resolution", "count"],
        required=True,
        help="Tool name to use",
    )
    parser.add_argument(
        "--input_image",
        type=str,
        required=True,
        help="Path to input image containing one or multiple objects",
    )
    parser.add_argument("--object_image", type=str, required=True, help="Path to object image")
    parser.add_argument("--threshold", type=float, required=True, help="Threshold for the ")
    parser.add_argument("--dedup_min_dist", type=float, required=True, help="Minimum distance to dedup matching results")
    args = parser.parse_args()
    return args


def count_objects(input_img_file: str, object_img_file: str, threshold: float, dedup_min_dist: float) -> int:
    """Count number of objects in `input_img_file`. An example object is shown in `object_img_file`.

    Both images must be in grey-scale before calling this function.
    """
    input_img = cv.imread(input_img_file, cv.IMREAD_GRAYSCALE)
    assert input_img is not None, f"File {input_img_file} could not be read, file not exist"

    template = cv.imread(object_img_file, cv.IMREAD_GRAYSCALE)
    assert template is not None, f"File {object_img_file} could not be read, file not exist"

    res = cv.matchTemplate(input_img, template, cv.TM_CCOEFF_NORMED)
    loc = np.where(res >= threshold)

    uniq_points = []

    def L2_dist(p1, p2):
        return np.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)

    for pt in zip(*loc[::-1]):
        if len(uniq_points) == 0:
            uniq_points.append(pt)
        else:
            closest_d = min(L2_dist(pt, p) for p in uniq_points)
            if closest_d > dedup_min_dist:
                uniq_points.append(pt)
    return len(uniq_points)


def app():
    args = get_args()
    if args.tool == "count":
        result = count_objects(args.input_image, args.object_image, args.threshold, args.dedup_min_dist)
        print(f"There are {result} objects (`{args.object_image}`) in file: `{args.input_image}`")
    else:
        raise NotImplementedError(f"Invalid tool name: {args.tool}")


if __name__ == "__main__":
    app()
