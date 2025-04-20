import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Export the classes for testing
export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public readonly isDirectory: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly isOutputFile: boolean = false
  ) {
    super(label, collapsibleState);
    this.tooltip = this.label;
    this.contextValue = isDirectory ? 'folderItem' : isOutputFile ? 'outputFileItem' : 'fileItem';
    if (!isDirectory) {
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    } else {
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    }
    this.iconPath = new vscode.ThemeIcon(isOutputFile ? 'copy' : 'file-code');
    if (isOutputFile) {
      this.command = {
        command: 'codebaseexporter.copyOutputContent',
        title: 'Copy Content',
        arguments: [this.resourceUri]
      };
    }
  }
}

export class FileTreeDataProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private checkedItems: Set<string> = new Set();
  private outputFilePath: string;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
    const config = vscode.workspace.getConfiguration('codebaseExporter');
    this.outputFilePath = config.get<string>('outputFilePath', 'codebase.txt');
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    element.checkboxState = this.checkedItems.has(element.resourceUri.toString())
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return element;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      this.outputChannel.appendLine('No workspace folder opened; cannot load files.');
      vscode.window.showWarningMessage('Please open a workspace folder to view files.');
      return [];
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const dirPath = element?.resourceUri?.fsPath ?? workspaceFolder.uri.fsPath;
    const items: FileItem[] = [];

    try {
      const stat = await fs.promises.stat(dirPath);
      if (!stat.isDirectory) {
        this.outputChannel.appendLine(`Path is not a directory: ${dirPath}`);
        return [];
      }

      const ignoreFilePath = path.join(workspaceFolder.uri.fsPath, '.codebaseignore');
      const ignorePatterns = fs.existsSync(ignoreFilePath)
        ? fs.readFileSync(ignoreFilePath, 'utf-8').split('\n').map(p => p.trim()).filter(p => p)
        : [];

      const files = await fs.promises.readdir(dirPath);
      for (const fileName of files) {
        const filePath = path.join(dirPath, fileName);
        if (this.isIgnored(filePath, ignorePatterns)) {
          continue;
        }

        try {
          const fileStat = await fs.promises.stat(filePath);
          const isDirectory = fileStat.isDirectory();
          const isOutput = filePath === path.join(workspaceFolder.uri.fsPath, this.outputFilePath);
          items.push(new FileItem(
            fileName,
            vscode.Uri.file(filePath),
            isDirectory,
            isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            isOutput
          ));
          if (this.checkedItems.has(vscode.Uri.file(filePath).toString())) {
            items[items.length - 1].checkboxState = vscode.TreeItemCheckboxState.Checked;
          }
        } catch (err) {
          this.outputChannel.appendLine(`Error accessing file ${filePath}: ${String(err)}`);
        }
      }

      // Ensure the output file is always included at the root level
      const outputFullPath = path.join(workspaceFolder.uri.fsPath, this.outputFilePath);
      if (!items.some(item => item.resourceUri.fsPath === outputFullPath) && fs.existsSync(outputFullPath)) {
        items.push(new FileItem(
          path.basename(this.outputFilePath),
          vscode.Uri.file(outputFullPath),
          false,
          vscode.TreeItemCollapsibleState.None,
          true
        ));
      }

      return items;
    } catch (err) {
      this.outputChannel.appendLine(`Error reading directory ${dirPath}: ${String(err)}`);
      vscode.window.showErrorMessage(`Failed to read directory: ${dirPath}`);
      return [];
    }
  }

  private isIgnored(filePath: string, patterns: string[]): boolean {
    const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
    return patterns.some(pattern => {
      const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
      return regex.test(relativePath);
    });
  }

  updateCheckedState(uri: vscode.Uri, state: vscode.TreeItemCheckboxState) {
    const uriStr = uri.toString();
    if (state === vscode.TreeItemCheckboxState.Checked) {
      this.checkedItems.add(uriStr);
    } else {
      this.checkedItems.delete(uriStr);
    }
    this.refresh();
    this.propagateFolderState(uri, state);
  }

  private async propagateFolderState(folderUri: vscode.Uri, state: vscode.TreeItemCheckboxState) {
    const isChecked = state === vscode.TreeItemCheckboxState.Checked;
    const files = await this.getAllFilesInFolder(folderUri.fsPath);
    files.forEach(fileUri => {
      if (isChecked) {
        this.checkedItems.add(fileUri.toString());
      } else {
        this.checkedItems.delete(fileUri.toString());
      }
    });
    this.refresh();
    await this.exportFolderContents(folderUri, isChecked);
  }

  public async exportFolderContents(folderUri: vscode.Uri, isChecked: boolean) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const config = vscode.workspace.getConfiguration('codebaseExporter');
    const outputFilePath = config.get<string>('outputFilePath', 'codebase.txt');
    const outputPath = path.join(workspaceFolder.uri.fsPath, outputFilePath);

    const files = await this.getAllFilesInFolder(folderUri.fsPath);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${isChecked ? 'to' : 'from'} ${outputFilePath}`,
      cancellable: false
    }, async (progress) => {
      let currentContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        progress.report({ message: `Processing ${path.basename(filePath)}...` });
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          if (isChecked && !currentContent.includes(filePath)) {
            currentContent += `\n${filePath}\n${content}\n---`;
            vscode.window.showInformationMessage(`${path.basename(filePath)} added to ${outputFilePath}`);
          } else if (!isChecked) {
            const startIdx = currentContent.indexOf(filePath);
            if (startIdx !== -1) {
              const endIdx = currentContent.indexOf('\n---', startIdx) + 4;
              currentContent = currentContent.slice(0, startIdx) + currentContent.slice(endIdx);
              vscode.window.showErrorMessage(`${path.basename(filePath)} removed from ${outputFilePath}`);
            }
          }
        } catch (err) {
          this.outputChannel.appendLine(`Error processing ${filePath}: ${String(err)}`);
          vscode.window.showErrorMessage(`Failed to process ${path.basename(filePath)}`);
        }
      }
      await fs.promises.writeFile(outputPath, currentContent.trim());
    });
  }

  public async getAllFilesInFolder(dirPath: string): Promise<vscode.Uri[]> {
    const uris: vscode.Uri[] = [];
    const files = await fs.promises.readdir(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        uris.push(...await this.getAllFilesInFolder(filePath));
      } else {
        uris.push(vscode.Uri.file(filePath));
      }
    }
    return uris;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Codebase Exporter');
  const treeDataProvider = new FileTreeDataProvider(context, outputChannel);
  const treeView = vscode.window.createTreeView('codeExporterFileExplorer', {
    treeDataProvider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
    canSelectMany: true
  });

  let actionHistory: { filePath: string; content: string; action: 'add' | 'remove' }[] = [];
  const maxHistory = 10;

  treeView.onDidChangeCheckboxState(async (event) => {
    const config = vscode.workspace.getConfiguration('codebaseExporter');
    const outputFilePath = config.get<string>('outputFilePath', 'codebase.txt');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const outputPath = path.join(workspaceFolder.uri.fsPath, outputFilePath);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Exporting files to " + outputFilePath,
      cancellable: false
    }, async (progress) => {
      for (const [item, state] of event.items) {
        if (!(item instanceof FileItem)) {
          continue;
        }

        if (item.isDirectory) {
          treeDataProvider.updateCheckedState(item.resourceUri, state);
          continue;
        }

        const filePath = item.resourceUri.fsPath;
        progress.report({ message: `Processing ${path.basename(filePath)}...` });

        try {
          const maxRetries = 3;
          let lastError: Error | undefined;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              if (!fs.existsSync(filePath)) {
                throw new Error(`File does not exist: ${filePath}`);
              }
              const stat = await fs.promises.stat(filePath);
              if (!stat.isFile()) {
                throw new Error(`Selected path is not a file: ${filePath}`);
              }
              await fs.promises.access(filePath, fs.constants.R_OK);

              const content = await fs.promises.readFile(filePath, 'utf-8');
              const outputDir = path.dirname(outputPath);
              await fs.promises.access(outputDir, fs.constants.W_OK).catch(async () => {
                await fs.promises.mkdir(outputDir, { recursive: true });
              });

              let currentContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
              let newContent = currentContent;
              if (state === vscode.TreeItemCheckboxState.Checked) {
                if (!currentContent.includes(filePath)) {
                  newContent += `\n${filePath}\n${content}\n---`;
                  actionHistory.push({ filePath, content, action: 'add' });
                  vscode.window.showInformationMessage(`${path.basename(filePath)} added to ${outputFilePath}`);
                }
              } else if (state === vscode.TreeItemCheckboxState.Unchecked) {
                const startIdx = currentContent.indexOf(filePath);
                if (startIdx !== -1) {
                  const endIdx = currentContent.indexOf('\n---', startIdx) + 4;
                  newContent = currentContent.slice(0, startIdx) + currentContent.slice(endIdx);
                  actionHistory.push({ filePath, content, action: 'remove' });
                  vscode.window.showErrorMessage(`${path.basename(filePath)} removed from ${outputFilePath}`);
                }
              }

              if (newContent !== currentContent) {
                await fs.promises.writeFile(outputPath, newContent.trim());
                outputChannel.appendLine(`${state === vscode.TreeItemCheckboxState.Checked ? 'Added' : 'Removed'} ${filePath} from ${outputPath}`);
              }
              break;
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              if (attempt === maxRetries) {
                throw lastError;
              }
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outputChannel.appendLine(`Error processing ${filePath}: ${message}`);
          vscode.window.showErrorMessage(`Failed to process ${path.basename(filePath)}: ${message}`);
        }
      }
      if (actionHistory.length > maxHistory) {
        actionHistory = actionHistory.slice(-maxHistory);
      }
    });
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('codebaseexporter.batchExport', async () => {
      const checkedItems = treeView.selection.filter(item => item instanceof FileItem && item.checkboxState === vscode.TreeItemCheckboxState.Checked);
      if (checkedItems.length === 0) {
        vscode.window.showWarningMessage('No files or folders selected for batch export.');
        return;
      }

      const config = vscode.workspace.getConfiguration('codebaseExporter');
      const outputFilePath = config.get<string>('outputFilePath', 'codebase.txt');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const outputPath = path.join(workspaceFolder.uri.fsPath, outputFilePath);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Batch Exporting to " + outputFilePath,
        cancellable: false
      }, async (progress) => {
        let currentContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
        const processedFiles = new Set<string>();

        for (const item of checkedItems) {
          if (item.isDirectory) {
            const files = await treeDataProvider.getAllFilesInFolder(item.resourceUri.fsPath);
            for (const fileUri of files) {
              if (!processedFiles.has(fileUri.fsPath)) {
                progress.report({ message: `Exporting ${path.basename(fileUri.fsPath)}...` });
                try {
                  const content = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
                  if (!currentContent.includes(fileUri.fsPath)) {
                    currentContent += `\n${fileUri.fsPath}\n${content}\n---`;
                    actionHistory.push({ filePath: fileUri.fsPath, content, action: 'add' });
                    vscode.window.showInformationMessage(`${path.basename(fileUri.fsPath)} added to ${outputFilePath}`);
                  }
                  processedFiles.add(fileUri.fsPath);
                } catch (err) {
                  outputChannel.appendLine(`Error exporting ${fileUri.fsPath}: ${String(err)}`);
                  vscode.window.showErrorMessage(`Failed to export ${path.basename(fileUri.fsPath)}`);
                }
              }
            }
          } else {
            const filePath = item.resourceUri.fsPath;
            if (!processedFiles.has(filePath)) {
              progress.report({ message: `Exporting ${path.basename(filePath)}...` });
              try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                if (!currentContent.includes(filePath)) {
                  currentContent += `\n${filePath}\n${content}\n---`;
                  actionHistory.push({ filePath, content, action: 'add' });
                  vscode.window.showInformationMessage(`${path.basename(filePath)} added to ${outputFilePath}`);
                }
                processedFiles.add(filePath);
              } catch (err) {
                outputChannel.appendLine(`Error exporting ${filePath}: ${String(err)}`);
                vscode.window.showErrorMessage(`Failed to export ${path.basename(filePath)}`);
              }
            }
          }
        }
        await fs.promises.writeFile(outputPath, currentContent.trim());
        outputChannel.appendLine(`Batch exported ${processedFiles.size} files to ${outputPath}`);
        vscode.window.showInformationMessage(`Batch exported ${processedFiles.size} files to ${outputFilePath}`);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebaseexporter.undoLastAction', async () => {
      if (actionHistory.length === 0) {
        vscode.window.showWarningMessage('No actions to undo.');
        return;
      }

      const lastAction = actionHistory.pop()!;
      const config = vscode.workspace.getConfiguration('codebaseExporter');
      const outputFilePath = config.get<string>('outputFilePath', 'codebase.txt');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const outputPath = path.join(workspaceFolder.uri.fsPath, outputFilePath);
      let currentContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';

      try {
        if (lastAction.action === 'add') {
          const startIdx = currentContent.indexOf(lastAction.filePath);
          if (startIdx !== -1) {
            const endIdx = currentContent.indexOf('\n---', startIdx) + 4;
            currentContent = currentContent.slice(0, startIdx) + currentContent.slice(endIdx);
          }
        } else if (lastAction.action === 'remove') {
          currentContent += `\n${lastAction.filePath}\n${lastAction.content}\n---`;
        }
        await fs.promises.writeFile(outputPath, currentContent.trim());
        outputChannel.appendLine(`Undid ${lastAction.action} for ${lastAction.filePath}`);
        vscode.window.showInformationMessage(`Undid last action for ${path.basename(lastAction.filePath)}`);
      } catch (err) {
        outputChannel.appendLine(`Error undoing action for ${lastAction.filePath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Failed to undo action: ${String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codebaseexporter.copyOutputContent', async (uri: vscode.Uri) => {
      try {
        const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage(`Copied content of ${path.basename(uri.fsPath)} to clipboard`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Error copying ${uri.fsPath}: ${message}`);
        vscode.window.showErrorMessage(`Failed to copy content: ${message}`);
      }
    })
  );

  context.subscriptions.push(treeView);
  context.subscriptions.push(outputChannel);
}

export function deactivate() {}