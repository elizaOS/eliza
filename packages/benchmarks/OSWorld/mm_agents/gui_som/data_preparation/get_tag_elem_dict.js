(() => {
    let labels = [];
    let selector_id_table = {};
    var generateQuerySelector = function (el) {
        function cssEscape(value) {
            if (!value) return '';
            // Escape all CSS special characters, including the colon.
            return value.replace(/([!"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$&');
        }

        function getChildIndex(el) {
            var siblings = Array.from(el.parentNode.children);
            var sameTagSiblings = siblings.filter(sibling => sibling.tagName === el.tagName);
            return sameTagSiblings.indexOf(el);
        }

        if (el.tagName.toLowerCase() === "html") {
            return "HTML";
        }

        var str = el.tagName;
        var idPresent = false; // Add a flag to check if an ID is present

        if (el.id !== "") {
            str += "#" + cssEscape(el.id);
            idPresent = true; // Set the flag to true if there's an ID
        }

        if (el.className) {
            var classes = el.className.split(/\s+/).filter(Boolean); // Filter out empty strings
            for (var i = 0; i < classes.length; i++) {
                str += "." + cssEscape(classes[i]);
            }
        }

        // Only add :nth-of-type() if no ID is present
        if (!idPresent) {
            str += ":nth-of-type(" + (getChildIndex(el) + 1) + ")";
        }

        // Use '>' combinator if parent is not 'HTML'
        var parentSelector = generateQuerySelector(el.parentNode);
        return parentSelector === "HTML" ? str : parentSelector + " > " + str;
    }


    function unmarkPage() {
        for (const label of labels) {
            document.body.removeChild(label);
        }
        labels = [];
    }

    // Expose the unmarkPage function globally
    window.unmarkPage = unmarkPage;

    function markPage() {
        unmarkPage();

        var bodyRect = document.body.getBoundingClientRect();

        var items = Array.prototype.slice.call(
            document.querySelectorAll('*')
        ).map(function (element) {
            var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
            var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

            var rects = [...element.getClientRects()].filter(bb => {
                var center_x = bb.left + bb.width / 2;
                var center_y = bb.top + bb.height / 2;
                var elAtCenter = document.elementFromPoint(center_x, center_y);

                return elAtCenter === element || element.contains(elAtCenter)
            }).map(bb => {
                const rect = {
                    left: Math.max(0, bb.left),
                    top: Math.max(0, bb.top),
                    right: Math.min(vw, bb.right),
                    bottom: Math.min(vh, bb.bottom)
                };
                return {
                    ...rect,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top
                }
            });

            var area = rects.reduce((acc, rect) => acc + rect.width * rect.height, 0);

            return {
                element: element,
                include:
                    (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") ||
                    (element.tagName === "BUTTON" || element.tagName === "A" || (element.onclick != null) || window.getComputedStyle(element).cursor == "pointer") ||
                    (element.tagName === "IFRAME" || element.tagName === "VIDEO")
                ,
                area,
                rects,
                text: element.textContent.trim().replace(/\s{2,}/g, ' ')
            };
        }).filter(item =>
            item.include && (item.area >= 20)
        );

        // Only keep inner clickable items
        items = items.filter(x => !items.some(y => x.element.contains(y.element) && !(x == y)))

        // Function to generate random colors
        function getRandomColor() {
            var letters = '0123456789ABCDEF';
            var color = '#';
            for (var i = 0; i < 6; i++) {
                color += letters[Math.floor(Math.random() * 16)];
            }
            return color;
        }

        // Lets create a floating border on top of these elements that will always be visible
        items.forEach(function (item, index) {
            selector_id_table[index.toString()] = item.rects;
            item.rects.forEach((bbox) => {
                newElement = document.createElement("div");
                var borderColor = getRandomColor();
                newElement.style.outline = `2px dashed ${borderColor}`;
                newElement.style.position = "fixed";
                newElement.style.left = bbox.left + "px";
                newElement.style.top = bbox.top + "px";
                newElement.style.width = bbox.width + "px";
                newElement.style.height = bbox.height + "px";
                newElement.style.pointerEvents = "none";
                newElement.style.boxSizing = "border-box";
                newElement.style.zIndex = 2147483647;
                // newElement.style.background = `${borderColor}80`;

                // Add floating label at the corner
                var label = document.createElement("span");
                label.textContent = index;
                label.style.position = "absolute";
                label.style.top = "-19px";
                label.style.left = "0px";
                label.style.background = borderColor;
                label.style.color = "white";
                label.style.padding = "2px 4px";
                label.style.fontSize = "12px";
                label.style.borderRadius = "2px";
                newElement.appendChild(label);

                document.body.appendChild(newElement);
                labels.push(newElement);
                // item.element.setAttribute("-ai-label", label.textContent);
            });
        })
        return selector_id_table;
    }

    return markPage();
})()

