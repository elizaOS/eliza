export const isPointInsideRect = (point, rect) =>
  point.x > rect.left &&
  point.x < rect.left + rect.width &&
  point.y > rect.top &&
  point.y < rect.top + rect.height;

export const distance = (point1, point2) => {
  const x = point2.x - point1.x;
  const y = point2.y - point1.y;
  return Math.sqrt(x * x + y * y);
};

// See https://github.com/substack/point-in-polygon/blob/master/nested.js
/*const pointInPolygon_ = ({ x, y }, vs) => {
  var inside = false;
  for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    var xi = vs[i][0],
      yi = vs[i][1];
    var xj = vs[j][0],
      yj = vs[j][1];
    var intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};*/

export const isPointInPolygon = ({ x, y }, vs) => {
  var inside = false;
  for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    var xi = vs[i].x,
      yi = vs[i].y;
    var xj = vs[j].x,
      yj = vs[j].y;
    var intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

// Links
// http://jeffreythompson.org/collision-detection/rect-rect.php

const vectorCenter = (point1, point2) => {
  return { x: (point1.x + point2.x) / 2, y: (point1.y + point2.y) / 2 };
};

export const rectRadius = (rect, center) => {
  const midP1A = vectorCenter(rect[0], rect[1]);
  const midP1B = vectorCenter(rect[1], rect[2]);
  const midP1 = vectorCenter(midP1A, midP1B);
  return distance(center, midP1);
};
