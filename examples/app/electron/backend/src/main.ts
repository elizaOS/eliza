import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerChatIpc } from "./ipc";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const preloadPath = join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl && rendererUrl.trim().length > 0) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    // renderer build is copied to backend/renderer via frontend build step
    const indexPath = join(process.cwd(), "renderer", "index.html");
    void mainWindow.loadFile(indexPath);
  }
}

app.whenReady().then(() => {
  registerChatIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

