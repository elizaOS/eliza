import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const ASSET_FILES = new Map<
  string,
  { relativePath: string; contentType: string }
>([
  [
    'swagger-ui.css',
    { relativePath: 'swagger-ui.css', contentType: 'text/css; charset=utf-8' },
  ],
  [
    'swagger-ui-bundle.js',
    {
      relativePath: 'swagger-ui-bundle.js',
      contentType: 'application/javascript; charset=utf-8',
    },
  ],
]);

const swaggerUiDistDir = path.resolve(
  process.cwd(),
  '../../',
  'node_modules/swagger-ui-react'
);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: requestedPath } = await params;
  const assetName = requestedPath.join('/');
  const asset = ASSET_FILES.get(assetName);

  if (!asset) {
    return new NextResponse('Not found', { status: 404 });
  }

  const assetPath = path.join(swaggerUiDistDir, asset.relativePath);
  const fileContents = await readFile(assetPath);

  return new NextResponse(fileContents, {
    headers: {
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=3600',
    },
  });
}
