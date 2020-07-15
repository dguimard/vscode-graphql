import {
  workspace,
  OutputChannel,
  TextDocumentContentProvider,
  EventEmitter,
  Uri,
  Event,
  ProviderResult,
  window,
  WebviewPanel,
  WorkspaceFolder,
} from "vscode"

import { ExtractedTemplateLiteral } from "./source-helper"
import {
  GraphQLConfig,
  GraphQLProjectConfig,
  loadConfigSync,
} from "graphql-config"
import { visit, VariableDefinitionNode } from "graphql"
import { NetworkHelper } from "./network-helper"
import { SourceHelper, GraphQLScalarTSType } from "./source-helper"

type Env = {
  [name: string]: string | undefined
}

export type UserVariables = { [key: string]: GraphQLScalarTSType }

// TODO: remove residue of previewHtml API https://github.com/microsoft/vscode/issues/62630
// We update the panel directly now in place of a event based update API (we might make a custom event updater and remove panel dep though)
export class GraphQLContentProvider implements TextDocumentContentProvider {
  private uri: Uri
  private outputChannel: OutputChannel
  private networkHelper: NetworkHelper
  private sourceHelper: SourceHelper
  private panel: WebviewPanel
  private rootDir: WorkspaceFolder | undefined
  private literal: ExtractedTemplateLiteral
  private env: Env

  // Event emitter which invokes document updates
  private _onDidChange = new EventEmitter<Uri>()

  private html: string = "" // HTML document buffer

  timeout = ms => new Promise(res => setTimeout(res, ms))

  getCurrentHtml(): Promise<string> {
    return new Promise(resolve => {
      resolve(this.html)
    })
  }

  updatePanel() {
    this.panel.webview.html = this.html
  }

  async getVariablesFromUser(
    variableDefinitionNodes: VariableDefinitionNode[],
  ): Promise<UserVariables> {
    await this.timeout(500)
    let variables = {}
    for (let node of variableDefinitionNodes) {
      variables = {
        ...variables,
        [`${node.variable.name.value}`]: this.sourceHelper.typeCast(
          await window.showInputBox({
            ignoreFocusOut: true,
            placeHolder: `Please enter the value for ${node.variable.name.value}`,
          }),
          this.sourceHelper.getTypeForVariableDefinitionNode(node),
        ),
      }
    }
    return variables
  }

  async getEndpointName(endpointNames: string[]) {
    // Endpoints extensions docs say that at least "default" will be there
    let endpointName = endpointNames[0]
    console.log({ endpoints: endpointNames.length })
    if (endpointNames.length > 1) {
      const pickedValue = await window.showQuickPick(endpointNames, {
        canPickMany: false,
        ignoreFocusOut: true,
        placeHolder: "Select an environment",
      })

      if (pickedValue) {
        endpointName = pickedValue
      }
    }
    return endpointName
  }

  /*
    Use the configration of first project if heuristics failed
    to find one.
  */
  patchProjectConfig(config: GraphQLConfig) {
    if (!config.projects) {
      return config
    }
    if (config.projects) {
      const projectKeys = Object.keys(config.projects)
      return config.getProject(projectKeys[0])
    }
    return null
  }

  constructor(
    uri: Uri,
    outputChannel: OutputChannel,
    literal: ExtractedTemplateLiteral,
    panel: WebviewPanel,
    env: Env,
  ) {
    this.uri = uri
    this.outputChannel = outputChannel
    this.networkHelper = new NetworkHelper(this.outputChannel)
    this.sourceHelper = new SourceHelper(this.outputChannel)
    this.panel = panel
    this.rootDir = workspace.getWorkspaceFolder(Uri.file(literal.uri))
    this.literal = literal
    this.env = env

    try {
      this.loadProvider()
        .then()
        .catch(err => {
          this.html = err.toString()
        })
    } catch (e) {
      this.html = e.toString()
    }
  }
  async loadProvider() {
    const projectConfig = await this.loadConfig()

    const endpoint = projectConfig!.schema as string

    let variableDefinitionNodes: VariableDefinitionNode[] = []
    visit(this.literal.ast, {
      VariableDefinition(node: VariableDefinitionNode) {
        variableDefinitionNodes.push(node)
      },
    })

    const updateCallback = (data: string, operation: string) => {
      if (operation === "subscription") {
        this.html = `<pre>${data}</pre>` + this.html
      } else {
        console.log({ data })
        this.html += `<pre>${data}</pre>`
      }
      this.update(this.uri)
      this.updatePanel()
    }

    if (variableDefinitionNodes.length > 0) {
      const variables = await this.getVariablesFromUser(variableDefinitionNodes)

      await this.networkHelper.executeOperation({
        endpoint,
        literal: this.literal,
        variables,
        updateCallback,
      })
    } else {
      console.log("exec op")
      await this.networkHelper.executeOperation({
        endpoint,
        literal: this.literal,
        variables: {},
        updateCallback,
      })
    }
  }
  async loadConfig() {
    const rootDir = this.rootDir
    if (!rootDir) {
      this.outputChannel.appendLine(
        `Error: this file is outside the workspace.`,
      )
      this.html = "Error: this file is outside the workspace."
      this.update(this.uri)
      this.updatePanel()
      return
    } else {
      console.log("about to load config")
      const config = loadConfigSync({ rootDir: rootDir!.uri.fsPath })
      console.log("config", { config })
      let projectConfig = config.getProjectForFile(this.literal.uri)
      if (!projectConfig) {
        projectConfig = this.patchProjectConfig(config) as GraphQLProjectConfig
      }

      if (!projectConfig!.schema) {
        this.outputChannel.appendLine(`Error: schema from graphql config`)
        this.html = "Error: schema missing from graphql config"
        this.update(this.uri)
        this.updatePanel()
        return
      }
      return projectConfig
    }
  }

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event
  }

  public update(uri: Uri) {
    this._onDidChange.fire(uri)
  }

  provideTextDocumentContent(_: Uri): ProviderResult<string> {
    return this.html
  }
}
