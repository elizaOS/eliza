import re


def parse_line(line):
    # 解析格式，如：label   Google Chrome   (191, 13)       (104, 17)
    pattern = r"^(\S+)\s+(.+?)\s+\((\d+), (\d+)\)\s+\((\d+), (\d+)\)"
    m = re.match(pattern, line)
    if not m:
        return None
    node_type, text, cx, cy, w, h = m.groups()
    cx, cy, w, h = map(int, (cx, cy, w, h))
    # bounding box as (x1, y1, x2, y2)
    x1 = cx - w // 2
    y1 = cy - h // 2
    x2 = x1 + w
    y2 = y1 + h
    return {
        "type": node_type,
        "text": text.strip(),
        "bbox": (x1, y1, x2, y2),
        "center": (cx, cy),
        "size": (w, h),
        "raw": line,
    }


def iou(box1, box2):
    # box: (x1, y1, x2, y2)
    xi1 = max(box1[0], box2[0])
    yi1 = max(box1[1], box2[1])
    xi2 = min(box1[2], box2[2])
    yi2 = min(box1[3], box2[3])
    inter_width = max(0, xi2 - xi1)
    inter_height = max(0, yi2 - yi1)
    inter_area = inter_width * inter_height
    area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
    union = area1 + area2 - inter_area
    if union == 0:
        return 0
    return inter_area / union


def norm_text(s):
    # 归一化文本：小写、去空格等
    return re.sub(r"\s+", "", s.lower())


def text_similarity(a, b):
    # 简单判定：完全一致为1，否则0
    na, nb = norm_text(a), norm_text(b)
    if na == nb:
        return 1.0
    else:
        return 0


def filter_similar_nodes(linearized_accessibility_tree):
    lines = [ln for ln in linearized_accessibility_tree.split("\n") if ln.strip()]
    # parse all nodes
    nodes = []
    for ln in lines:
        node = parse_line(ln)
        if node:
            nodes.append(node)
        else:
            # 解析不了的保留
            nodes.append({"raw": ln, "invalid": True})
    filtered = []
    removed = [False] * len(nodes)
    # 阈值可自行调整
    IOU_THRESH = 0.2
    TEXT_THRESH = 0.9
    for i, ni in enumerate(nodes):
        if ni.get("invalid"):
            filtered.append(ni["raw"])
            continue
        if removed[i]:
            continue
        for j in range(i + 1, len(nodes)):
            nj = nodes[j]
            if nj.get("invalid"):
                continue
            iou_val = iou(ni["bbox"], nj["bbox"])
            text_sim = text_similarity(ni["text"], nj["text"])
            if iou_val > IOU_THRESH and text_sim > TEXT_THRESH:
                # 二者极其相似，移除后者
                removed[j] = True
                # print(f"移除: {nj['raw']} (与 {ni['raw']} 相似度高)")
        # 保留未被标记为移除的
        if not removed[i]:
            filtered.append(ni["raw"])
    return "\n".join(filtered)


# 示例用法
if __name__ == "__main__":
    linearized_accessibility_tree = "tag\ttext\tposition (center x & y)\tsize (w & h)\nicon\t\t(1853, 1001)\t(64, 64)\nlabel\tHome\t(1853, 1045)\t(40, 17)\nlabel\tActivities\t(49, 13)\t(63, 17)\ntext\tActivities\t(49, 13)\t(63, 17)\nlabel\tApr 17 17‎∶04\t(995, 13)\t(117, 27)\ntext\tApr 17 17‎∶04\t(995, 13)\t(87, 18)\nmenu\tSystem\t(1867, 13)\t(106, 27)\npush-button\tGoogle Chrome\t(35, 65)\t(70, 64)\npush-button\tThunderbird Mail\t(35, 133)\t(70, 64)\npush-button\tVisual Studio Code\t(35, 201)\t(70, 64)\npush-button\tVLC media player\t(35, 269)\t(70, 64)\npush-button\tLibreOffice Writer\t(35, 337)\t(70, 64)\npush-button\tLibreOffice Calc\t(35, 405)\t(70, 64)\npush-button\tLibreOffice Impress\t(35, 473)\t(70, 64)\npush-button\tGNU Image Manipulation Program\t(35, 541)\t(70, 64)\npush-button\tFiles\t(35, 609)\t(70, 64)\npush-button\tUbuntu Software\t(35, 677)\t(70, 64)\npush-button\tHelp\t(35, 745)\t(70, 64)\npush-button\tTrash\t(35, 816)\t(70, 64)\ntoggle-button\tShow Applications\t(35, 1045)\t(70, 70)"
    result = filter_similar_nodes(linearized_accessibility_tree)
    print(result)
