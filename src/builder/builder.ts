import path from 'path';
import fs from 'fs';
import mkdirp from 'mkdirp';
import globule from 'globule';
import chokidar from 'chokidar';
import normalizePath from 'normalize-path';
import { castArray, map } from 'lodash';

import amxxpc, { AMXPCMessageType } from './amxxpc';
import { IProjectConfig } from '../types';
import { ASSETS_PATH_PATTERN, INCLUDE_PATH_PATTERN, SCRIPTS_PATH_PATTERN } from './constants';
import logger from '../logger/logger';
import findRelativePath from '../utils/find-relative-path';

export interface BuildOptions {
  ignoreErrors?: boolean;
}

export default class AmxxBuilder {
  constructor(private config: IProjectConfig) {}

  async build(options: BuildOptions): Promise<void> {
    logger.info('Building...');

    await this.buildAssets();
    await this.buildInclude();

    const success = await this.buildSrc(options);

    if (success) {
    logger.success('Build finished!');
    } else {
      logger.error('Build finished with errors!');
    }
  }

  async watch(): Promise<void> {
    await this.watchAssets();
    await this.watchInclude();
    await this.watchSrc();
  }

  async buildSrc(options: BuildOptions): Promise<boolean> {
    let success = true;

    await this.buildDir(
      this.config.input.scripts,
      SCRIPTS_PATH_PATTERN,
      async (filePath: string) => {
        try {
          await this.updatePlugin(filePath);
        } catch (err) {
          if (!options.ignoreErrors) {
            throw err;
          }

          success = false;
        }
      }
    );

    return success;
  }

  async buildInclude(): Promise<void> {
    await this.buildDir(
      this.config.input.include,
      INCLUDE_PATH_PATTERN,
      (filePath: string) => this.updateInclude(filePath)
    );
  }

  async buildAssets(): Promise<void> {
    if (!this.config.input.assets) {
      return;
    }

    await this.buildDir(
      this.config.input.assets,
      ASSETS_PATH_PATTERN,
      (filePath: string) => this.updateAsset(filePath)
    );
  }

  async watchSrc(): Promise<void> {
    await this.watchDir(
      this.config.input.scripts,
      SCRIPTS_PATH_PATTERN,
      (filePath: string) => this.updatePlugin(filePath)
    );
  }

  async watchInclude(): Promise<void> {
    await this.watchDir(
      this.config.input.include,
      INCLUDE_PATH_PATTERN,
      (filePath: string) => this.updateInclude(filePath)
    );
  }

  async watchAssets(): Promise<void> {
    if (!this.config.input.assets) {
      return;
    }

    await this.watchDir(
      this.config.input.assets,
      ASSETS_PATH_PATTERN,
      (filePath: string) => this.updateAsset(filePath)
    );
  }

  async updatePlugin(filePath: string): Promise<void> {
    await this.updateScript(filePath);
    await this.compilePlugin(filePath);
  }

  async updateScript(filePath: string): Promise<void> {
    if (!this.config.output.scripts) {
      return;
    }

    const srcPath = path.resolve(filePath);
    const destPath = path.join(this.config.output.scripts, path.parse(filePath).base);

    await mkdirp(this.config.output.scripts);
    await fs.promises.copyFile(srcPath, destPath);
    logger.info('Script updated:', normalizePath(destPath));
  }

  async updateAsset(filePath: string): Promise<void> {
    const srcPath = path.resolve(filePath);

    const relativePath = findRelativePath(castArray(this.config.input.assets), filePath);
    if (!relativePath) {
      throw new Error(`Cannot find relative path for asset "${filePath}"`);
    }

    const destPath = path.join(this.config.output.assets, relativePath);

    await mkdirp(path.parse(destPath).dir);
    await fs.promises.copyFile(srcPath, destPath);
    logger.info('Asset updated', normalizePath(destPath));
  }

  async updateInclude(filePath: string): Promise<void> {
    const srcPath = path.resolve(filePath);
    const destPath = path.join(this.config.output.include, path.parse(filePath).base);

    await mkdirp(this.config.output.include);
    await fs.promises.copyFile(srcPath, destPath);
    logger.info('Include updated:', normalizePath(destPath));
  }

  async findPlugins(pattern: string): Promise<string[]> {
    const pathPattern = map(castArray(this.config.input.scripts), (dir) => path.join(dir, '**', pattern));
    const matches = await globule.find(pathPattern);

    return matches.filter((filePath) => path.extname(filePath) === '.sma');
  }

  async compilePlugin(filePath: string): Promise<void> {
    const srcPath = path.resolve(filePath);

    let destDir = path.resolve(this.config.output.plugins);
    if (!this.config.rules.flatCompilation) {
      const srcDir = path.parse(srcPath).dir;

      const relativePath = findRelativePath(castArray(this.config.input.scripts), srcDir);
      if (!relativePath) {
        throw new Error(`Cannot find relative path for plugin "${filePath}"`);
      }

      destDir = path.join(destDir, relativePath);
    }

    const relateiveSrcPath = path.relative(process.cwd(), srcPath);
    const executable = path.join(this.config.compiler.dir, this.config.compiler.executable);

    await mkdirp(destDir);

    const result = await amxxpc({
      path: srcPath,
      dest: destDir,
      compiler: executable,
      includeDir: [
        path.join(this.config.compiler.dir, 'include'),
        ...this.config.include,
        ...castArray(this.config.input.include),
      ]
    });

    result.output.messages.forEach((message) => {
      const { startLine, type, code, text, filename } = message;
      const relativeFilePath = filename ? path.relative(process.cwd(), filename) : relateiveSrcPath;

      if (type === AMXPCMessageType.Error || type === AMXPCMessageType.FatalError) {
        logger.error(`${normalizePath(relativeFilePath)}(${startLine})`, type, code, ':', text);
      } else if (type === AMXPCMessageType.Warning) {
        logger.warn(`${normalizePath(relativeFilePath)}(${startLine})`, type, code, ':', text);
      } else if (type === AMXPCMessageType.Echo) {
        logger.debug(text);
      }
    });

    if (result.success) {
      const destPath = path.join(destDir, result.plugin);
      const relativeFilePath = path.relative(process.cwd(), filePath);
      logger.success('Compilation success:', normalizePath(relativeFilePath));
      logger.info('Plugin updated:', normalizePath(destPath));
    } else {
      throw new Error(`Failed to compile ${normalizePath(relateiveSrcPath)} : "${result.error}"`);
    }
  }

  private async buildDir(
    baseDir: string | string[],
    pattern: string,
    cb: (filePath: string) => any
  ): Promise<void> {
    const pathPattern = map(castArray(baseDir), (dir) => path.join(dir, pattern));
    const matches = await globule.find(pathPattern, { nodir: true });
    await matches.reduce(
      (acc, match) => acc.then(() => cb(match)),
      Promise.resolve()
    );
  }

  private async watchDir(
    baseDir: string | string[],
    pattern: string,
    cb: (filePath: string) => any
  ): Promise<void> {
    const pathPattern = map(castArray(baseDir), (dir) => path.join(dir, pattern));
    const watcher = chokidar.watch(pathPattern, { ignoreInitial: true, interval: 300 });

    const updateFn = (filePath: string) => cb(filePath).catch(
      (err: Error) => logger.error(err.message)
    );

    watcher.on('add', updateFn);
    watcher.on('change', updateFn);
  }
}
