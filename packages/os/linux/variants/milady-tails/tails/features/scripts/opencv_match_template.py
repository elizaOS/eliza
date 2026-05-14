#!/usr/bin/env python3

import os
import sys
import traceback

import cv2


class FindFailed(RuntimeError):
    pass


def match(image, candidate, sensitivity, show_match=False, show_candidate=False):
    """Return the pos of candidate inside image, or raises if no match."""
    assert sensitivity < 1.0
    if not os.path.exists(image):
        raise FileNotFoundError
    image_rgb = cv2.imread(image, cv2.IMREAD_COLOR)
    image_gray = cv2.cvtColor(image_rgb, cv2.COLOR_BGR2GRAY)
    template = cv2.imread(candidate, cv2.IMREAD_GRAYSCALE)
    w, h = template.shape[::-1]
    res = cv2.matchTemplate(image_gray, template, cv2.TM_CCOEFF_NORMED)
    _, val, _, (x, y) = cv2.minMaxLoc(res)
    if val < sensitivity:
        raise FindFailed
    cv2.imwrite(
        os.environ.get("TMPDIR", "/tmp") + "/last_opencv_match.png",
        image_rgb[y : y + h, x : x + w],
    )
    if show_match:
        if show_candidate:
            try:
                template_rgb = cv2.imread(candidate, cv2.IMREAD_COLOR)
                image_width, image_height, _ = image_rgb.shape
                try:
                    xx = x + w + 3
                    yy = y
                    if xx + w > image_width - 1:
                        xx = x - w - 3
                    assert xx - 1 >= 0
                    assert xx + w < image_width
                except AssertionError:
                    xx = x
                    yy = y + h + 3
                    if yy + h > image_height - 1:
                        yy = y - h - 3
                    assert yy - 1 >= 0
                    assert yy + h < image_height
                image_rgb[yy : yy + h, xx : xx + w] = template_rgb
                cv2.rectangle(
                    image_rgb, (xx - 1, yy - 1), (xx + w, yy + h), (0, 0, 255), 1
                )
            except:
                # Apparently we cannot fit the old candidate
                pass
        cv2.rectangle(image_rgb, (x - 1, y - 1), (x + w, y + h), (0, 255, 0), 1)
        cv2.imshow("Found match!", image_rgb)
        cv2.waitKey(0)
    return [x, y, w, h]


def main():
    if len(sys.argv) < 3:
        print(
            "error: first argument must be the screen and the second the "
            + "image to find inside the screen",
            file=sys.stderr,
        )
        sys.exit(2)
    try:
        try:
            sensitivity = float(sys.argv[3])
        except IndexError:
            sensitivity = 0.9
        try:
            show_match = sys.argv[4] == "true"
        except IndexError:
            show_match = False
        try:
            show_candidate = sys.argv[5] == "true"
        except IndexError:
            show_candidate = False
        print(*match(sys.argv[1], sys.argv[2], sensitivity, show_match, show_candidate))
    except FindFailed:
        print("FindFailed")
    except:
        traceback.print_exc()
        sys.exit(127)


if __name__ == "__main__":
    main()
