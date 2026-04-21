import Foundation
import Capacitor
import UIKit
import CoreGraphics
import WebKit

// MARK: - Plugin Registration

@objc(ElizaCanvasPlugin)
public class ElizaCanvasPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaCanvasPlugin"
    public let jsName = "ElizaCanvas"
    public let pluginMethods: [CAPPluginMethod] = [
        // Drawing canvas
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createLayer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateLayer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteLayer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLayers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawRect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawEllipse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawPath", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drawBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPixelData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "toImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTransform", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetTransform", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTouchEnabled", returnType: CAPPluginReturnPromise),
        // Web canvas
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "eval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "a2uiPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "a2uiReset", returnType: CAPPluginReturnPromise),
    ]

    private var canvases: [String: ManagedCanvas] = [:]
    private var nextCanvasId = 1
    private var nextLayerId = 1

    // MARK: - Create / Destroy

    @objc func create(_ call: CAPPluginCall) {
        guard let sizeObj = call.getObject("size"),
              let width = sizeObj["width"] as? Int,
              let height = sizeObj["height"] as? Int else {
            call.reject("Missing size parameter")
            return
        }

        let canvasId = "canvas_\(nextCanvasId)"
        nextCanvasId += 1

        let size = CGSize(width: width, height: height)
        let canvas = ManagedCanvas(id: canvasId, size: size)

        if let bgColorObj = call.getObject("backgroundColor") {
            let color = colorFromObject(bgColorObj)
            DispatchQueue.main.async {
                canvas.view.backgroundColor = color
            }
        }

        canvases[canvasId] = canvas
        call.resolve(["canvasId": canvasId])
    }

    @objc func destroy(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId") else {
            call.reject("Missing canvasId")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let canvas = self?.canvases[canvasId] else {
                call.resolve()
                return
            }
            canvas.webView?.removeFromSuperview()
            canvas.view.removeFromSuperview()
            self?.canvases.removeValue(forKey: canvasId)
            call.resolve()
        }
    }

    // MARK: - Attach / Detach

    @objc func attach(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else {
                call.reject("WebView not found")
                return
            }

            canvas.view.frame = webView.bounds
            canvas.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            webView.superview?.insertSubview(canvas.view, belowSubview: webView)
            webView.isOpaque = false
            webView.backgroundColor = .clear

            // If a web canvas exists, ensure it's also in the hierarchy.
            if let wv = canvas.webView {
                wv.frame = canvas.view.bounds
                wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                canvas.view.insertSubview(wv, at: 0)
            }

            canvas.view.touchHandler = { [weak self] type, touches in
                guard let self = self, canvas.touchEnabled else { return }
                let touchArray = touches.map { touch -> [String: Any] in
                    var dict: [String: Any] = [
                        "id": touch.id,
                        "x": touch.x,
                        "y": touch.y,
                    ]
                    if let force = touch.force {
                        dict["force"] = force
                    }
                    return dict
                }
                self.notifyListeners("touch", data: [
                    "type": type,
                    "touches": touchArray,
                    "timestamp": Date().timeIntervalSince1970 * 1000,
                ])
            }

            call.resolve()
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        DispatchQueue.main.async {
            canvas.view.removeFromSuperview()
            call.resolve()
        }
    }

    // MARK: - Resize / Clear

    @objc func resize(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let sizeObj = call.getObject("size"),
              let width = sizeObj["width"] as? Int,
              let height = sizeObj["height"] as? Int else {
            call.reject("Missing parameters")
            return
        }

        DispatchQueue.main.async {
            canvas.size = CGSize(width: width, height: height)
            canvas.view.frame.size = canvas.size
            canvas.webView?.frame.size = canvas.size
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        let layerId = call.getString("layerId")
        let rectObj = call.getObject("rect")

        DispatchQueue.main.async {
            let targetView: CanvasView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view

            if let rectObj = rectObj,
               let x = rectObj["x"] as? CGFloat,
               let y = rectObj["y"] as? CGFloat,
               let width = rectObj["width"] as? CGFloat,
               let height = rectObj["height"] as? CGFloat {
                guard let ctx = targetView.createContext() else { return }
                ctx.clear(CGRect(x: x, y: y, width: width, height: height))
                targetView.commitContext()
            } else {
                targetView.setImage(nil)
            }

            call.resolve()
        }
    }

    // MARK: - Layer Operations

    @objc func createLayer(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let layerObj = call.getObject("layer") else {
            call.reject("Missing parameters")
            return
        }

        let layerId = "layer_\(nextLayerId)"
        nextLayerId += 1

        let visible = layerObj["visible"] as? Bool ?? true
        let opacity = layerObj["opacity"] as? Double ?? 1.0
        let zIndex = layerObj["zIndex"] as? Int ?? 0
        let name = layerObj["name"] as? String

        DispatchQueue.main.async { [weak self] in
            let layer = ManagedLayer(
                id: layerId,
                size: canvas.size,
                visible: visible,
                opacity: CGFloat(opacity),
                zIndex: zIndex,
                name: name
            )

            canvas.layers[layerId] = layer
            canvas.view.addSubview(layer.view)
            self?.sortLayers(canvas: canvas)

            call.resolve(["layerId": layerId])
        }
    }

    @objc func updateLayer(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let layerId = call.getString("layerId"),
              let layer = canvas.layers[layerId],
              let layerObj = call.getObject("layer") else {
            call.reject("Layer not found")
            return
        }

        DispatchQueue.main.async { [weak self] in
            if let visible = layerObj["visible"] as? Bool {
                layer.visible = visible
                layer.view.isHidden = !visible
            }
            if let opacity = layerObj["opacity"] as? Double {
                layer.opacity = CGFloat(opacity)
                layer.view.alpha = layer.opacity
            }
            if let zIndex = layerObj["zIndex"] as? Int {
                layer.zIndex = zIndex
                self?.sortLayers(canvas: canvas)
            }
            if let name = layerObj["name"] as? String {
                layer.name = name
            }
            call.resolve()
        }
    }

    @objc func deleteLayer(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let layerId = call.getString("layerId"),
              let layer = canvas.layers[layerId] else {
            call.reject("Layer not found")
            return
        }

        DispatchQueue.main.async {
            layer.view.removeFromSuperview()
            canvas.layers.removeValue(forKey: layerId)
            call.resolve()
        }
    }

    @objc func getLayers(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        let layers = canvas.layers.values.map { layer -> [String: Any] in
            var dict: [String: Any] = [
                "id": layer.id,
                "visible": layer.visible,
                "opacity": layer.opacity,
                "zIndex": layer.zIndex,
            ]
            if let name = layer.name {
                dict["name"] = name
            }
            return dict
        }

        call.resolve(["layers": layers])
    }

    // MARK: - Drawing Operations

    @objc func drawRect(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let rectObj = call.getObject("rect") else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String
        let fillObj = call.getObject("fill")
        let strokeObj = call.getObject("stroke")
        let cornerRadius = call.getFloat("cornerRadius") ?? 0

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard let ctx = targetView.createContext() else {
                call.reject("Failed to create context")
                return
            }

            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)
            self.renderRect(ctx, rect: self.rectFromObject(rectObj), fill: fillObj, stroke: strokeObj, cornerRadius: CGFloat(cornerRadius))
            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawEllipse(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let centerObj = call.getObject("center"),
              let radiusX = call.getFloat("radiusX"),
              let radiusY = call.getFloat("radiusY") else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String
        let fillObj = call.getObject("fill")
        let strokeObj = call.getObject("stroke")

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard let ctx = targetView.createContext() else {
                call.reject("Failed to create context")
                return
            }

            let cx = centerObj["x"] as? CGFloat ?? 0
            let cy = centerObj["y"] as? CGFloat ?? 0

            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)
            self.renderEllipse(ctx, center: CGPoint(x: cx, y: cy), radiusX: CGFloat(radiusX), radiusY: CGFloat(radiusY), fill: fillObj, stroke: strokeObj)
            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawLine(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let fromObj = call.getObject("from"),
              let toObj = call.getObject("to"),
              let strokeObj = call.getObject("stroke") else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard let ctx = targetView.createContext() else {
                call.reject("Failed to create context")
                return
            }

            let from = CGPoint(x: fromObj["x"] as? CGFloat ?? 0, y: fromObj["y"] as? CGFloat ?? 0)
            let to = CGPoint(x: toObj["x"] as? CGFloat ?? 0, y: toObj["y"] as? CGFloat ?? 0)

            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)
            self.renderLine(ctx, from: from, to: to, stroke: strokeObj)
            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawPath(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let pathObj = call.getObject("path"),
              let commands = pathObj["commands"] as? [[String: Any]] else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String
        let fillObj = call.getObject("fill")
        let strokeObj = call.getObject("stroke")

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard let ctx = targetView.createContext() else {
                call.reject("Failed to create context")
                return
            }

            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)
            self.renderPath(ctx, commands: commands, fill: fillObj, stroke: strokeObj)
            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawText(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let text = call.getString("text"),
              let positionObj = call.getObject("position"),
              let styleObj = call.getObject("style") else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard targetView.createContext() != nil else {
                call.reject("Failed to create context")
                return
            }

            let ctx = UIGraphicsGetCurrentContext()!
            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)
            self.renderText(ctx, text: text, position: positionObj, style: styleObj)
            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawImage(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let destRectObj = call.getObject("destRect") else {
            call.reject("Missing parameters")
            return
        }

        let drawOpts = call.getObject("drawOptions")
        let layerId = drawOpts?["layerId"] as? String
        let imageObj = call.getObject("image")
        let imageString = call.getString("image")
        let srcRectObj = call.getObject("srcRect")

        DispatchQueue.main.async {
            let targetView = layerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
            guard let ctx = targetView.createContext() else {
                call.reject("Failed to create context")
                return
            }

            var image: UIImage?

            if let imageObj = imageObj, let base64 = imageObj["base64"] as? String {
                if let data = Data(base64Encoded: base64) {
                    image = UIImage(data: data)
                }
            } else if let imageString = imageString, let url = URL(string: imageString) {
                if let data = try? Data(contentsOf: url) {
                    image = UIImage(data: data)
                }
            }

            guard let uiImage = image else {
                targetView.commitContext()
                call.reject("Failed to load image")
                return
            }

            self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)

            let destRect = self.rectFromObject(destRectObj)

            if let srcRectObj = srcRectObj {
                // Crop source image to srcRect, then draw into destRect.
                let srcRect = self.rectFromObject(srcRectObj)
                if let cgImage = uiImage.cgImage,
                   let cropped = cgImage.cropping(to: srcRect) {
                    UIImage(cgImage: cropped).draw(in: destRect)
                } else {
                    uiImage.draw(in: destRect)
                }
            } else {
                uiImage.draw(in: destRect)
            }

            self.restoreDrawOptions(ctx, options: drawOpts)

            targetView.commitContext()
            call.resolve()
        }
    }

    @objc func drawBatch(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let commands = call.getArray("commands") as? [[String: Any]] else {
            call.reject("Missing parameters")
            return
        }

        DispatchQueue.main.async {
            // Group consecutive commands by target view for efficiency.
            var currentLayerId: String? = nil
            var currentView: CanvasView = canvas.view
            var contextOpen = false

            let openContext = { (view: CanvasView) -> CGContext? in
                let ctx = view.createContext()
                return ctx
            }
            let closeContext = { (view: CanvasView) in
                view.commitContext()
            }

            for command in commands {
                guard let type = command["type"] as? String,
                      let args = command["args"] as? [String: Any] else {
                    continue
                }

                let drawOpts = args["drawOptions"] as? [String: Any]
                let targetLayerId = drawOpts?["layerId"] as? String

                // Switch target view if layer changed.
                if targetLayerId != currentLayerId {
                    if contextOpen {
                        closeContext(currentView)
                        contextOpen = false
                    }
                    currentLayerId = targetLayerId
                    currentView = targetLayerId.flatMap { canvas.layers[$0]?.view } ?? canvas.view
                }

                if !contextOpen {
                    guard openContext(currentView) != nil else { continue }
                    contextOpen = true
                }

                let ctx = UIGraphicsGetCurrentContext()!
                self.applyDrawOptions(ctx, canvas: canvas, options: drawOpts)

                switch type {
                case "rect":
                    if let rectObj = args["rect"] as? [String: Any] {
                        let fill = args["fill"] as? [String: Any]
                        let stroke = args["stroke"] as? [String: Any]
                        let cr = args["cornerRadius"] as? CGFloat ?? 0
                        self.renderRect(ctx, rect: self.rectFromObject(rectObj), fill: fill, stroke: stroke, cornerRadius: cr)
                    }
                case "ellipse":
                    if let centerObj = args["center"] as? [String: Any],
                       let rx = args["radiusX"] as? CGFloat,
                       let ry = args["radiusY"] as? CGFloat {
                        let cx = centerObj["x"] as? CGFloat ?? 0
                        let cy = centerObj["y"] as? CGFloat ?? 0
                        self.renderEllipse(ctx, center: CGPoint(x: cx, y: cy), radiusX: rx, radiusY: ry, fill: args["fill"] as? [String: Any], stroke: args["stroke"] as? [String: Any])
                    }
                case "line":
                    if let fromObj = args["from"] as? [String: Any],
                       let toObj = args["to"] as? [String: Any],
                       let strokeObj = args["stroke"] as? [String: Any] {
                        let from = CGPoint(x: fromObj["x"] as? CGFloat ?? 0, y: fromObj["y"] as? CGFloat ?? 0)
                        let to = CGPoint(x: toObj["x"] as? CGFloat ?? 0, y: toObj["y"] as? CGFloat ?? 0)
                        self.renderLine(ctx, from: from, to: to, stroke: strokeObj)
                    }
                case "path":
                    if let pathObj = args["path"] as? [String: Any],
                       let pathCommands = pathObj["commands"] as? [[String: Any]] {
                        self.renderPath(ctx, commands: pathCommands, fill: args["fill"] as? [String: Any], stroke: args["stroke"] as? [String: Any])
                    }
                case "text":
                    if let text = args["text"] as? String,
                       let posObj = args["position"] as? [String: Any],
                       let styleObj = args["style"] as? [String: Any] {
                        self.renderText(ctx, text: text, position: posObj, style: styleObj)
                    }
                case "image":
                    if let destRectObj = args["destRect"] as? [String: Any] {
                        let destRect = self.rectFromObject(destRectObj)
                        var img: UIImage?
                        if let imgObj = args["image"] as? [String: Any],
                           let b64 = imgObj["base64"] as? String,
                           let data = Data(base64Encoded: b64) {
                            img = UIImage(data: data)
                        } else if let imgStr = args["image"] as? String,
                                  let url = URL(string: imgStr),
                                  let data = try? Data(contentsOf: url) {
                            img = UIImage(data: data)
                        }
                        if let uiImage = img {
                            if let srcRectObj = args["srcRect"] as? [String: Any],
                               let cgImage = uiImage.cgImage,
                               let cropped = cgImage.cropping(to: self.rectFromObject(srcRectObj)) {
                                UIImage(cgImage: cropped).draw(in: destRect)
                            } else {
                                uiImage.draw(in: destRect)
                            }
                        }
                    }
                case "clear":
                    let clearRect = (args["rect"] as? [String: Any]).map { self.rectFromObject($0) }
                    if let clearRect = clearRect {
                        ctx.clear(clearRect)
                    } else {
                        // Close current context, clear the view, reopen if more commands follow.
                        closeContext(currentView)
                        contextOpen = false
                        currentView.setImage(nil)
                    }
                default:
                    break
                }

                self.restoreDrawOptions(ctx, options: drawOpts)
            }

            if contextOpen {
                closeContext(currentView)
            }

            call.resolve()
        }
    }

    // MARK: - Pixel Data / Export

    @objc func getPixelData(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        let rectObj = call.getObject("rect")

        DispatchQueue.main.async {
            // Composite all layers into a single image.
            let renderer = UIGraphicsImageRenderer(size: canvas.size)
            let composited = renderer.image { _ in
                canvas.view.drawHierarchy(in: CGRect(origin: .zero, size: canvas.size), afterScreenUpdates: true)
            }

            guard let cgImage = composited.cgImage else {
                call.reject("No image data")
                return
            }

            // Determine the region to extract.
            let region: CGRect
            if let rectObj = rectObj {
                region = self.rectFromObject(rectObj)
            } else {
                region = CGRect(origin: .zero, size: canvas.size)
            }

            let pixelW = Int(region.width)
            let pixelH = Int(region.height)
            guard pixelW > 0, pixelH > 0 else {
                call.reject("Invalid dimensions")
                return
            }

            // Extract RGBA pixel data.
            let bytesPerPixel = 4
            let bytesPerRow = bytesPerPixel * pixelW
            var pixelData = [UInt8](repeating: 0, count: bytesPerRow * pixelH)

            guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                    data: &pixelData,
                    width: pixelW,
                    height: pixelH,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  ) else {
                call.reject("Failed to create bitmap context")
                return
            }

            // Draw the cropped region into our pixel buffer.
            let drawRect = CGRect(x: -region.origin.x, y: -region.origin.y,
                                  width: CGFloat(cgImage.width), height: CGFloat(cgImage.height))
            context.draw(cgImage, in: drawRect)

            let base64 = Data(pixelData).base64EncodedString()

            call.resolve([
                "data": base64,
                "width": pixelW,
                "height": pixelH,
            ])
        }
    }

    @objc func toImage(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        let imageFormat = call.getString("format") ?? "png"
        let quality = call.getFloat("quality") ?? 100
        let layerIds = call.getArray("layerIds") as? [String]

        DispatchQueue.main.async {
            let renderer = UIGraphicsImageRenderer(size: canvas.size)
            let image = renderer.image { _ in
                if let layerIds = layerIds {
                    // Only render specified layers.
                    for lid in layerIds {
                        if let layer = canvas.layers[lid] {
                            layer.view.drawHierarchy(in: CGRect(origin: .zero, size: canvas.size), afterScreenUpdates: true)
                        }
                    }
                } else {
                    canvas.view.drawHierarchy(in: CGRect(origin: .zero, size: canvas.size), afterScreenUpdates: true)
                }
            }

            var data: Data?
            var outputFormat = imageFormat

            switch imageFormat {
            case "jpeg":
                data = image.jpegData(compressionQuality: CGFloat(quality / 100))
            case "webp":
                // WebP not natively supported; fall back to PNG.
                data = image.pngData()
                outputFormat = "png"
            default:
                data = image.pngData()
                outputFormat = "png"
            }

            guard let imageData = data else {
                call.reject("Failed to encode image")
                return
            }

            call.resolve([
                "base64": imageData.base64EncodedString(),
                "format": outputFormat,
                "width": Int(canvas.size.width),
                "height": Int(canvas.size.height),
            ])
        }
    }

    // MARK: - Transform

    @objc func setTransform(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let transformObj = call.getObject("transform") else {
            call.reject("Missing parameters")
            return
        }

        canvas.globalTransform = affineTransformFromObject(transformObj)
        call.resolve()
    }

    @objc func resetTransform(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        canvas.globalTransform = .identity
        call.resolve()
    }

    // MARK: - Touch

    @objc func setTouchEnabled(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let enabled = call.getBool("enabled") else {
            call.reject("Missing parameters")
            return
        }

        DispatchQueue.main.async {
            canvas.touchEnabled = enabled
            canvas.view.isUserInteractionEnabled = enabled
            call.resolve()
        }
    }

    // MARK: - Web Canvas: Navigate

    @objc func navigate(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let urlString = call.getString("url") else {
            call.reject("Missing parameters")
            return
        }

        let placement = call.getObject("placement")

        DispatchQueue.main.async { [weak self] in
            let wv = self?.ensureWebView(for: canvas) ?? canvas.webView!

            // Apply placement if provided, otherwise fill the canvas.
            if let placement = placement {
                let x = placement["x"] as? CGFloat ?? 0
                let y = placement["y"] as? CGFloat ?? 0
                let w = placement["width"] as? CGFloat ?? canvas.size.width
                let h = placement["height"] as? CGFloat ?? canvas.size.height
                wv.frame = CGRect(x: x, y: y, width: w, height: h)
            }

            let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: trimmed) else {
                call.reject("Invalid URL: \(trimmed)")
                return
            }

            if url.isFileURL {
                wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            } else {
                wv.load(URLRequest(url: url))
            }

            call.resolve(["url": trimmed])
        }
    }

    // MARK: - Web Canvas: Eval

    @objc func eval(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId],
              let script = call.getString("script") else {
            call.reject("Missing parameters")
            return
        }

        guard let wv = canvas.webView else {
            call.reject("No web view - call navigate() first")
            return
        }

        DispatchQueue.main.async {
            wv.evaluateJavaScript(script) { result, error in
                if let error = error {
                    call.reject("eval failed: \(error.localizedDescription)")
                    return
                }
                if let result = result {
                    call.resolve(["result": String(describing: result)])
                } else {
                    call.resolve(["result": ""])
                }
            }
        }
    }

    // MARK: - Web Canvas: Snapshot

    @objc func snapshot(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        guard let wv = canvas.webView else {
            call.reject("No web view - call navigate() first")
            return
        }

        let maxWidth = call.getFloat("maxWidth").flatMap { CGFloat($0) }
        let quality = call.getDouble("quality") ?? 0.82
        let formatStr = call.getString("format") ?? "png"

        DispatchQueue.main.async {
            let config = WKSnapshotConfiguration()
            if let maxWidth = maxWidth {
                config.snapshotWidth = NSNumber(value: Double(maxWidth))
            }

            wv.takeSnapshot(with: config) { image, error in
                if let error = error {
                    call.reject("snapshot failed: \(error.localizedDescription)")
                    return
                }
                guard let image = image else {
                    call.reject("snapshot returned nil")
                    return
                }

                let data: Data?
                var outputFormat = formatStr
                switch formatStr {
                case "jpeg":
                    let q = min(max(quality, 0.1), 1.0)
                    data = image.jpegData(compressionQuality: q)
                default:
                    data = image.pngData()
                    outputFormat = "png"
                }

                guard let encoded = data else {
                    call.reject("snapshot encode failed")
                    return
                }

                call.resolve([
                    "base64": encoded.base64EncodedString(),
                    "format": outputFormat,
                    "width": Int(image.size.width),
                    "height": Int(image.size.height),
                ])
            }
        }
    }

    // MARK: - Web Canvas: A2UI Push

    @objc func a2uiPush(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        guard let wv = canvas.webView else {
            call.reject("No web view - call navigate() first")
            return
        }

        // Accept either "messages" (JSON array) or "jsonl" (newline-delimited JSON string).
        let messagesJSON: String
        if let messages = call.getArray("messages") {
            guard let data = try? JSONSerialization.data(withJSONObject: messages),
                  let json = String(data: data, encoding: .utf8) else {
                call.reject("Failed to serialize messages")
                return
            }
            messagesJSON = json
        } else if let jsonl = call.getString("jsonl") {
            // Parse JSONL: each non-empty line is a JSON object; collect into an array.
            var parsed: [Any] = []
            for rawLine in jsonl.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
                let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
                if line.isEmpty { continue }
                guard let lineData = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: lineData) else {
                    call.reject("Invalid JSONL at line: \(line.prefix(80))")
                    return
                }
                parsed.append(obj)
            }
            guard let data = try? JSONSerialization.data(withJSONObject: parsed),
                  let json = String(data: data, encoding: .utf8) else {
                call.reject("Failed to serialize parsed JSONL")
                return
            }
            messagesJSON = json
        } else if let payload = call.getObject("payload") {
            // Single payload object wrapped in array.
            guard let data = try? JSONSerialization.data(withJSONObject: [payload]),
                  let json = String(data: data, encoding: .utf8) else {
                call.reject("Failed to serialize payload")
                return
            }
            messagesJSON = json
        } else {
            call.reject("Missing messages, jsonl, or payload parameter")
            return
        }

        // Escape the JSON for embedding in a JS string literal.
        let escapedJSON = Self.jsStringLiteral(messagesJSON)

        let js = """
        (() => {
          try {
            const host = globalThis.elizaA2UI;
            if (host && typeof host.applyMessages === 'function') {
              host.applyMessages(JSON.parse(\(escapedJSON)));
              return 'ok';
            }
            return 'a2ui_not_ready';
          } catch (e) {
            return 'error:' + e.message;
          }
        })()
        """

        DispatchQueue.main.async {
            wv.evaluateJavaScript(js) { result, error in
                if let error = error {
                    call.reject("a2uiPush failed: \(error.localizedDescription)")
                    return
                }
                let resultStr = (result as? String) ?? ""
                if resultStr == "a2ui_not_ready" {
                    call.reject("A2UI host not ready - ensure the canvas page includes the A2UI runtime")
                } else if resultStr.hasPrefix("error:") {
                    call.reject("a2uiPush JS error: \(resultStr)")
                } else {
                    call.resolve()
                }
            }
        }
    }

    // MARK: - Web Canvas: A2UI Reset

    @objc func a2uiReset(_ call: CAPPluginCall) {
        guard let canvasId = call.getString("canvasId"),
              let canvas = canvases[canvasId] else {
            call.reject("Canvas not found")
            return
        }

        guard let wv = canvas.webView else {
            call.reject("No web view - call navigate() first")
            return
        }

        let js = """
        (() => {
          try {
            const host = globalThis.elizaA2UI;
            if (host && typeof host.reset === 'function') {
              host.reset();
              return 'ok';
            }
            return 'no_reset';
          } catch (e) {
            return 'error:' + e.message;
          }
        })()
        """

        DispatchQueue.main.async {
            wv.evaluateJavaScript(js) { result, error in
                if let error = error {
                    call.reject("a2uiReset failed: \(error.localizedDescription)")
                    return
                }
                call.resolve()
            }
        }
    }

    // MARK: - Web View Management

    @MainActor
    @discardableResult
    private func ensureWebView(for canvas: ManagedCanvas) -> WKWebView {
        if let existing = canvas.webView { return existing }

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()

        let ucc = WKUserContentController()
        let handler = CanvasA2UIMessageHandler(plugin: self, canvasId: canvas.id)
        ucc.add(handler, name: CanvasA2UIMessageHandler.messageName)
        config.userContentController = ucc

        let navDelegate = CanvasNavigationDelegate(plugin: self, canvasId: canvas.id)

        let wv = WKWebView(frame: CGRect(origin: .zero, size: canvas.size), configuration: config)
        wv.isOpaque = true
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.contentInset = .zero
        wv.scrollView.isScrollEnabled = true
        wv.scrollView.bounces = true
        wv.navigationDelegate = navDelegate

        canvas.webView = wv
        canvas.navigationDelegate = navDelegate
        canvas.a2uiHandler = handler

        // Insert the web view behind drawing layers in the canvas view hierarchy.
        if canvas.view.superview != nil {
            wv.frame = canvas.view.bounds
            wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            canvas.view.insertSubview(wv, at: 0)
            // Make drawing view transparent so web content shows through.
            canvas.view.backgroundColor = .clear
        }

        return wv
    }

    // MARK: - Internal Render Helpers

    /// Apply draw options (blend mode, opacity, shadow, transform) to the context.
    private func applyDrawOptions(_ ctx: CGContext, canvas: ManagedCanvas, options: [String: Any]?) {
        ctx.saveGState()

        // Global canvas transform.
        if canvas.globalTransform != .identity {
            ctx.concatenate(canvas.globalTransform)
        }

        guard let options = options else { return }

        // Per-operation transform.
        if let transformObj = options["transform"] as? [String: Any] {
            ctx.concatenate(affineTransformFromObject(transformObj))
        }

        // Blend mode.
        if let blendStr = options["blendMode"] as? String {
            ctx.setBlendMode(blendModeFromString(blendStr))
        }

        // Opacity.
        if let opacity = options["opacity"] as? Double {
            ctx.setAlpha(CGFloat(opacity))
        }

        // Shadow.
        if let shadowObj = options["shadow"] as? [String: Any] {
            let blur = shadowObj["blur"] as? CGFloat ?? 0
            let offsetX = shadowObj["offsetX"] as? CGFloat ?? 0
            let offsetY = shadowObj["offsetY"] as? CGFloat ?? 0
            let color: CGColor
            if let colorObj = shadowObj["color"] as? [String: Any] {
                color = colorFromObject(colorObj).cgColor
            } else if let colorStr = shadowObj["color"] as? String {
                color = (UIColor(hex: colorStr) ?? .black).cgColor
            } else {
                color = UIColor.black.withAlphaComponent(0.5).cgColor
            }
            ctx.setShadow(offset: CGSize(width: offsetX, height: offsetY), blur: blur, color: color)
        }
    }

    private func restoreDrawOptions(_ ctx: CGContext, options: [String: Any]?) {
        ctx.restoreGState()
    }

    private func renderRect(_ ctx: CGContext, rect: CGRect, fill: [String: Any]?, stroke: [String: Any]?, cornerRadius: CGFloat) {
        let path: UIBezierPath
        if cornerRadius > 0 {
            path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
        } else {
            path = UIBezierPath(rect: rect)
        }

        if let fill = fill {
            if let gradient = extractGradient(fill) {
                ctx.saveGState()
                path.addClip()
                drawGradient(ctx, gradient: gradient)
                ctx.restoreGState()
            } else {
                let color = colorFromFillOrStroke(fill)
                color.setFill()
                path.fill()
            }
        }

        if let stroke = stroke {
            let color = colorFromFillOrStroke(stroke)
            let width = stroke["width"] as? CGFloat ?? 1
            color.setStroke()
            path.lineWidth = width
            applyStrokeStyle(path, style: stroke)
            path.stroke()
        }
    }

    private func renderEllipse(_ ctx: CGContext, center: CGPoint, radiusX: CGFloat, radiusY: CGFloat, fill: [String: Any]?, stroke: [String: Any]?) {
        let rect = CGRect(
            x: center.x - radiusX,
            y: center.y - radiusY,
            width: radiusX * 2,
            height: radiusY * 2
        )
        let path = UIBezierPath(ovalIn: rect)

        if let fill = fill {
            if let gradient = extractGradient(fill) {
                ctx.saveGState()
                path.addClip()
                drawGradient(ctx, gradient: gradient)
                ctx.restoreGState()
            } else {
                let color = colorFromFillOrStroke(fill)
                color.setFill()
                path.fill()
            }
        }

        if let stroke = stroke {
            let color = colorFromFillOrStroke(stroke)
            let width = stroke["width"] as? CGFloat ?? 1
            color.setStroke()
            path.lineWidth = width
            applyStrokeStyle(path, style: stroke)
            path.stroke()
        }
    }

    private func renderLine(_ ctx: CGContext, from: CGPoint, to: CGPoint, stroke: [String: Any]) {
        let path = UIBezierPath()
        path.move(to: from)
        path.addLine(to: to)

        let color = colorFromFillOrStroke(stroke)
        let width = stroke["width"] as? CGFloat ?? 1
        color.setStroke()
        path.lineWidth = width
        applyStrokeStyle(path, style: stroke)
        path.stroke()
    }

    private func renderPath(_ ctx: CGContext, commands: [[String: Any]], fill: [String: Any]?, stroke: [String: Any]?) {
        let cgPath = CGMutablePath()

        for cmd in commands {
            guard let type = cmd["type"] as? String else { continue }
            let args = cmd["args"] as? [Double] ?? []

            switch type {
            case "moveTo" where args.count >= 2:
                cgPath.move(to: CGPoint(x: args[0], y: args[1]))

            case "lineTo" where args.count >= 2:
                cgPath.addLine(to: CGPoint(x: args[0], y: args[1]))

            case "quadraticCurveTo" where args.count >= 4:
                cgPath.addQuadCurve(
                    to: CGPoint(x: args[2], y: args[3]),
                    control: CGPoint(x: args[0], y: args[1])
                )

            case "bezierCurveTo" where args.count >= 6:
                cgPath.addCurve(
                    to: CGPoint(x: args[4], y: args[5]),
                    control1: CGPoint(x: args[0], y: args[1]),
                    control2: CGPoint(x: args[2], y: args[3])
                )

            case "arcTo" where args.count >= 5:
                cgPath.addArc(
                    tangent1End: CGPoint(x: args[0], y: args[1]),
                    tangent2End: CGPoint(x: args[2], y: args[3]),
                    radius: CGFloat(args[4])
                )

            case "arc" where args.count >= 5:
                let cx = args[0], cy = args[1], radius = args[2]
                let startAngle = args[3], endAngle = args[4]
                // In UIKit's flipped coordinate system, CGPath clockwise parameter
                // is inverted visually. Canvas 2D counterclockwise maps to CGPath clockwise.
                let counterclockwise = args.count > 5 ? (args[5] != 0) : false
                cgPath.addArc(
                    center: CGPoint(x: cx, y: cy),
                    radius: CGFloat(radius),
                    startAngle: CGFloat(startAngle),
                    endAngle: CGFloat(endAngle),
                    clockwise: counterclockwise
                )

            case "ellipse" where args.count >= 7:
                let cx = args[0], cy = args[1]
                let rx = args[2], ry = args[3]
                let rotation = args[4]
                let startAngle = args[5], endAngle = args[6]
                let counterclockwise = args.count > 7 ? (args[7] != 0) : false
                // Use transform to draw an elliptical arc.
                var t = CGAffineTransform(translationX: CGFloat(cx), y: CGFloat(cy))
                t = t.rotated(by: CGFloat(rotation))
                t = t.scaledBy(x: CGFloat(rx), y: CGFloat(ry))
                cgPath.addArc(
                    center: .zero,
                    radius: 1.0,
                    startAngle: CGFloat(startAngle),
                    endAngle: CGFloat(endAngle),
                    clockwise: counterclockwise,
                    transform: t
                )

            case "rect" where args.count >= 4:
                cgPath.addRect(CGRect(x: args[0], y: args[1], width: args[2], height: args[3]))

            case "closePath":
                cgPath.closeSubpath()

            default:
                break
            }
        }

        let bezierPath = UIBezierPath(cgPath: cgPath)

        if let fill = fill {
            if let gradient = extractGradient(fill) {
                ctx.saveGState()
                bezierPath.addClip()
                drawGradient(ctx, gradient: gradient)
                ctx.restoreGState()
            } else {
                let color = colorFromFillOrStroke(fill)
                color.setFill()
                bezierPath.fill()
            }
        }

        if let stroke = stroke {
            let color = colorFromFillOrStroke(stroke)
            let width = stroke["width"] as? CGFloat ?? 1
            color.setStroke()
            bezierPath.lineWidth = width
            applyStrokeStyle(bezierPath, style: stroke)
            bezierPath.stroke()
        }
    }

    private func renderText(_ ctx: CGContext, text: String, position: [String: Any], style: [String: Any]) {
        let x = position["x"] as? CGFloat ?? 0
        let y = position["y"] as? CGFloat ?? 0

        let fontName = style["font"] as? String ?? "Helvetica"
        let fontSize = style["size"] as? CGFloat ?? 14
        let color = colorFromFillOrStroke(style)
        let align = style["align"] as? String ?? "left"
        let maxWidth = style["maxWidth"] as? CGFloat

        let uiFont = UIFont(name: fontName, size: fontSize) ?? UIFont.systemFont(ofSize: fontSize)

        var attributes: [NSAttributedString.Key: Any] = [
            .font: uiFont,
            .foregroundColor: color,
        ]

        let paragraph = NSMutableParagraphStyle()
        switch align {
        case "center": paragraph.alignment = .center
        case "right": paragraph.alignment = .right
        default: paragraph.alignment = .left
        }
        attributes[.paragraphStyle] = paragraph

        let nsText = text as NSString
        let textSize = nsText.size(withAttributes: attributes)

        // Adjust position based on alignment.
        var drawPoint = CGPoint(x: x, y: y)
        switch align {
        case "center":
            drawPoint.x -= textSize.width / 2
        case "right":
            drawPoint.x -= textSize.width
        default:
            break
        }

        // Handle baseline adjustment.
        if let baseline = style["baseline"] as? String {
            switch baseline {
            case "top":
                break // default
            case "middle":
                drawPoint.y -= textSize.height / 2
            case "bottom", "alphabetic":
                drawPoint.y -= textSize.height
            default:
                break
            }
        }

        if let maxWidth = maxWidth {
            let drawRect = CGRect(x: drawPoint.x, y: drawPoint.y, width: maxWidth, height: textSize.height * 2)
            nsText.draw(in: drawRect, withAttributes: attributes)
        } else {
            nsText.draw(at: drawPoint, withAttributes: attributes)
        }
    }

    // MARK: - Gradient Support

    private func extractGradient(_ obj: [String: Any]) -> [String: Any]? {
        guard let type = obj["type"] as? String,
              (type == "linear" || type == "radial") else {
            return nil
        }
        return obj
    }

    private func drawGradient(_ ctx: CGContext, gradient gradientObj: [String: Any]) {
        guard let type = gradientObj["type"] as? String,
              let stops = gradientObj["stops"] as? [[String: Any]] else { return }

        var colors: [CGColor] = []
        var locations: [CGFloat] = []
        for stop in stops {
            let offset = stop["offset"] as? CGFloat ?? 0
            locations.append(offset)
            if let colorObj = stop["color"] as? [String: Any] {
                colors.append(colorFromObject(colorObj).cgColor)
            } else if let colorStr = stop["color"] as? String {
                colors.append((UIColor(hex: colorStr) ?? .black).cgColor)
            } else {
                colors.append(UIColor.black.cgColor)
            }
        }

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations) else {
            return
        }

        switch type {
        case "linear":
            let x0 = gradientObj["x0"] as? CGFloat ?? 0
            let y0 = gradientObj["y0"] as? CGFloat ?? 0
            let x1 = gradientObj["x1"] as? CGFloat ?? 0
            let y1 = gradientObj["y1"] as? CGFloat ?? 0
            ctx.drawLinearGradient(gradient, start: CGPoint(x: x0, y: y0), end: CGPoint(x: x1, y: y1),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        case "radial":
            let x0 = gradientObj["x0"] as? CGFloat ?? 0
            let y0 = gradientObj["y0"] as? CGFloat ?? 0
            let r0 = gradientObj["r0"] as? CGFloat ?? 0
            let x1 = gradientObj["x1"] as? CGFloat ?? 0
            let y1 = gradientObj["y1"] as? CGFloat ?? 0
            let r1 = gradientObj["r1"] as? CGFloat ?? 0
            ctx.drawRadialGradient(gradient,
                                   startCenter: CGPoint(x: x0, y: y0), startRadius: r0,
                                   endCenter: CGPoint(x: x1, y: y1), endRadius: r1,
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        default:
            break
        }
    }

    // MARK: - Stroke Style

    private func applyStrokeStyle(_ path: UIBezierPath, style: [String: Any]) {
        if let lineCap = style["lineCap"] as? String {
            switch lineCap {
            case "round": path.lineCapStyle = .round
            case "square": path.lineCapStyle = .square
            default: path.lineCapStyle = .butt
            }
        }
        if let lineJoin = style["lineJoin"] as? String {
            switch lineJoin {
            case "round": path.lineJoinStyle = .round
            case "bevel": path.lineJoinStyle = .bevel
            default: path.lineJoinStyle = .miter
            }
        }
        if let dashPattern = style["dashPattern"] as? [Double] {
            let pattern = dashPattern.map { CGFloat($0) }
            path.setLineDash(pattern, count: pattern.count, phase: 0)
        }
    }

    // MARK: - Utility Helpers

    private func sortLayers(canvas: ManagedCanvas) {
        let sorted = canvas.layers.values.sorted { $0.zIndex < $1.zIndex }
        for (index, layer) in sorted.enumerated() {
            // Offset by 1 if web view is at index 0.
            let insertIdx = canvas.webView != nil ? index + 1 : index
            canvas.view.insertSubview(layer.view, at: insertIdx)
        }
    }

    private func colorFromObject(_ obj: [String: Any]?) -> UIColor {
        guard let obj = obj else { return .black }

        let r = obj["r"] as? Int ?? 0
        let g = obj["g"] as? Int ?? 0
        let b = obj["b"] as? Int ?? 0
        let a = obj["a"] as? Double ?? 1.0

        return UIColor(
            red: CGFloat(r) / 255.0,
            green: CGFloat(g) / 255.0,
            blue: CGFloat(b) / 255.0,
            alpha: CGFloat(a)
        )
    }

    /// Extract a color from a fill or stroke style object. Handles both `{ color: ... }` wrappers
    /// and direct color objects, as well as hex string colors.
    private func colorFromFillOrStroke(_ obj: [String: Any]) -> UIColor {
        if let colorObj = obj["color"] as? [String: Any] {
            return colorFromObject(colorObj)
        }
        if let colorStr = obj["color"] as? String {
            return UIColor(hex: colorStr) ?? .black
        }
        // Maybe the object itself is a color.
        if obj["r"] != nil {
            return colorFromObject(obj)
        }
        return .black
    }

    private func rectFromObject(_ obj: [String: Any]) -> CGRect {
        let x = obj["x"] as? CGFloat ?? 0
        let y = obj["y"] as? CGFloat ?? 0
        let width = obj["width"] as? CGFloat ?? 0
        let height = obj["height"] as? CGFloat ?? 0
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func affineTransformFromObject(_ obj: [String: Any]) -> CGAffineTransform {
        var t = CGAffineTransform.identity
        if let tx = obj["translateX"] as? CGFloat {
            t = t.translatedBy(x: tx, y: 0)
        }
        if let ty = obj["translateY"] as? CGFloat {
            t = t.translatedBy(x: 0, y: ty)
        }
        if let sx = obj["scaleX"] as? CGFloat, let sy = obj["scaleY"] as? CGFloat {
            t = t.scaledBy(x: sx, y: sy)
        } else if let sx = obj["scaleX"] as? CGFloat {
            t = t.scaledBy(x: sx, y: 1)
        } else if let sy = obj["scaleY"] as? CGFloat {
            t = t.scaledBy(x: 1, y: sy)
        }
        if let rotation = obj["rotation"] as? CGFloat {
            t = t.rotated(by: rotation)
        }
        if let skewX = obj["skewX"] as? CGFloat {
            t = t.concatenating(CGAffineTransform(a: 1, b: 0, c: tan(skewX), d: 1, tx: 0, ty: 0))
        }
        if let skewY = obj["skewY"] as? CGFloat {
            t = t.concatenating(CGAffineTransform(a: 1, b: tan(skewY), c: 0, d: 1, tx: 0, ty: 0))
        }
        return t
    }

    private func blendModeFromString(_ str: String) -> CGBlendMode {
        switch str {
        case "multiply": return .multiply
        case "screen": return .screen
        case "overlay": return .overlay
        case "darken": return .darken
        case "lighten": return .lighten
        case "color-dodge": return .colorDodge
        case "color-burn": return .colorBurn
        default: return .normal
        }
    }

    /// Produce a properly JSON-escaped JS string literal (single-quoted).
    static func jsStringLiteral(_ value: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let encoded = String(data: data, encoding: .utf8),
           encoded.count >= 2 {
            // encoded is '["..."]'; extract the inner string literal including quotes.
            let inner = encoded.dropFirst(1).dropLast(1)
            return String(inner)
        }
        // Fallback: manual escape.
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        return "\"\(escaped)\""
    }
}

// MARK: - ManagedCanvas

extension ElizaCanvasPlugin {
    class ManagedCanvas {
        let id: String
        var view: CanvasView
        var webView: WKWebView?
        var layers: [String: ManagedLayer] = [:]
        var size: CGSize
        var touchEnabled = false
        var globalTransform: CGAffineTransform = .identity
        var navigationDelegate: CanvasNavigationDelegate?
        var a2uiHandler: CanvasA2UIMessageHandler?

        init(id: String, size: CGSize) {
            self.id = id
            self.size = size
            self.view = CanvasView(frame: CGRect(origin: .zero, size: size))
        }
    }

    class ManagedLayer {
        let id: String
        var name: String?
        var visible: Bool
        var opacity: CGFloat
        var zIndex: Int
        var view: CanvasView

        init(id: String, size: CGSize, visible: Bool, opacity: CGFloat, zIndex: Int, name: String?) {
            self.id = id
            self.name = name
            self.visible = visible
            self.opacity = opacity
            self.zIndex = zIndex
            self.view = CanvasView(frame: CGRect(origin: .zero, size: size))
            self.view.alpha = opacity
            self.view.isHidden = !visible
        }
    }
}

// MARK: - CanvasView

extension ElizaCanvasPlugin {
    class CanvasView: UIView {
        private var drawingImage: UIImage?
        var touchHandler: ((String, [TouchInfo]) -> Void)?

        struct TouchInfo {
            let id: Int
            let x: CGFloat
            let y: CGFloat
            let force: CGFloat?
        }

        override func draw(_ rect: CGRect) {
            drawingImage?.draw(in: bounds)
        }

        func setImage(_ image: UIImage?) {
            drawingImage = image
            setNeedsDisplay()
        }

        func getImage() -> UIImage? {
            return drawingImage
        }

        func createContext() -> CGContext? {
            UIGraphicsBeginImageContextWithOptions(bounds.size, false, 1.0)
            if let currentImage = drawingImage {
                currentImage.draw(in: bounds)
            }
            return UIGraphicsGetCurrentContext()
        }

        func commitContext() {
            drawingImage = UIGraphicsGetImageFromCurrentImageContext()
            UIGraphicsEndImageContext()
            setNeedsDisplay()
        }

        // MARK: Touch Handling

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            handleTouches(touches, type: "start")
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
            handleTouches(touches, type: "move")
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
            handleTouches(touches, type: "end")
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
            handleTouches(touches, type: "cancel")
        }

        private func handleTouches(_ touches: Set<UITouch>, type: String) {
            let touchInfos = touches.map { touch -> TouchInfo in
                let location = touch.location(in: self)
                return TouchInfo(
                    id: touch.hash,
                    x: location.x,
                    y: location.y,
                    force: touch.force > 0 ? touch.force : nil
                )
            }
            touchHandler?(type, touchInfos)
        }
    }
}

// MARK: - WKNavigationDelegate

/// Handles navigation policy for the canvas web view: intercepts eliza:// deep links,
/// reports load errors, and emits navigation events to the Capacitor layer.
// `@MainActor` on the whole delegate class lets us invoke
// `decisionHandler` (which WebKit now types as `@MainActor @Sendable`
// in modern SDKs) synchronously from the nonisolated
// `webView(_:decidePolicyFor:decisionHandler:)` method. Without the
// isolation, Swift 6 strict concurrency rejects the direct call with:
//   error: call to main actor-isolated parameter 'decisionHandler'
//   in a synchronous nonisolated context
// WKNavigationDelegate callbacks are always invoked by WebKit on the
// main thread, so this matches the actual runtime contract.
@MainActor
final class CanvasNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var plugin: ElizaCanvasPlugin?
    let canvasId: String

    init(plugin: ElizaCanvasPlugin, canvasId: String) {
        self.plugin = plugin
        self.canvasId = canvasId
        super.init()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        // Intercept eliza:// deep links.
        if url.scheme?.lowercased() == "eliza" {
            decisionHandler(.cancel)
            plugin?.notifyListeners("deepLink", data: [
                "canvasId": canvasId,
                "url": url.absoluteString,
            ])
            return
        }

        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        plugin?.notifyListeners("webViewReady", data: [
            "canvasId": canvasId,
            "url": webView.url?.absoluteString ?? "",
        ])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        plugin?.notifyListeners("navigationError", data: [
            "canvasId": canvasId,
            "error": error.localizedDescription,
        ])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        plugin?.notifyListeners("navigationError", data: [
            "canvasId": canvasId,
            "error": error.localizedDescription,
        ])
    }
}

// MARK: - A2UI Message Handler

/// Receives A2UI action messages from the canvas web view (e.g. button taps in A2UI components)
/// and forwards them as Capacitor events.
final class CanvasA2UIMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "elizaCanvasA2UIAction"

    weak var plugin: ElizaCanvasPlugin?
    let canvasId: String

    init(plugin: ElizaCanvasPlugin, canvasId: String) {
        self.plugin = plugin
        self.canvasId = canvasId
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }

        // Only accept actions from local/trusted URLs.
        guard let webView = message.webView, let url = webView.url else { return }
        if !url.isFileURL, !Self.isLocalNetworkURL(url) {
            return
        }

        guard let body = parseBody(message.body) else { return }

        let userAction = (body["userAction"] as? [String: Any]) ?? body
        guard !userAction.isEmpty else { return }

        let actionName = extractActionName(userAction)
        let actionId = (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? UUID().uuidString
        let surfaceId = (userAction["surfaceId"] as? String) ?? "main"

        plugin?.notifyListeners("a2uiAction", data: [
            "canvasId": canvasId,
            "actionId": actionId,
            "actionName": actionName ?? "",
            "surfaceId": surfaceId,
            "userAction": userAction,
        ])

        // Dispatch action status acknowledgement back to the web view.
        let statusJS = """
        (() => {
          const detail = { id: \(ElizaCanvasPlugin.jsStringLiteral(actionId)), ok: true, error: '' };
          window.dispatchEvent(new CustomEvent('eliza:a2ui-action-status', { detail }));
        })();
        """
        webView.evaluateJavaScript(statusJS) { _, _ in }
    }

    private func parseBody(_ body: Any) -> [String: Any]? {
        if let dict = body as? [String: Any] { return dict.isEmpty ? nil : dict }
        if let str = body as? String,
           let data = str.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return json.isEmpty ? nil : json
        }
        return nil
    }

    private func extractActionName(_ userAction: [String: Any]) -> String? {
        for key in ["name", "action"] {
            if let raw = userAction[key] as? String {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    static func isLocalNetworkURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return false
        }
        if host == "localhost" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasSuffix(".tailscale.net") { return true }
        // Allow bare hostnames (no dots, no colons) as LAN names.
        if !host.contains("."), !host.contains(":") { return true }
        // Check for private IPv4 ranges.
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4 {
            let bytes: [UInt8] = parts.compactMap { UInt8($0) }
            if bytes.count == 4 {
                let (a, b) = (bytes[0], bytes[1])
                if a == 10 { return true }
                if a == 172, (16...31).contains(Int(b)) { return true }
                if a == 192, b == 168 { return true }
                if a == 127 { return true }
                if a == 169, b == 254 { return true }
                if a == 100, (64...127).contains(Int(b)) { return true }
            }
        }
        return false
    }
}

// MARK: - UIColor Hex Extension

extension UIColor {
    convenience init?(hex: String) {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")

        var rgb: UInt64 = 0
        guard Scanner(string: hexSanitized).scanHexInt64(&rgb) else { return nil }

        switch hexSanitized.count {
        case 6:
            let r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
            let g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
            let b = CGFloat(rgb & 0x0000FF) / 255.0
            self.init(red: r, green: g, blue: b, alpha: 1.0)
        case 8:
            let r = CGFloat((rgb & 0xFF000000) >> 24) / 255.0
            let g = CGFloat((rgb & 0x00FF0000) >> 16) / 255.0
            let b = CGFloat((rgb & 0x0000FF00) >> 8) / 255.0
            let a = CGFloat(rgb & 0x000000FF) / 255.0
            self.init(red: r, green: g, blue: b, alpha: a)
        default:
            return nil
        }
    }
}
