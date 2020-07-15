import { ExtractedTemplateLiteral } from "./source-helper";
import { OperationDefinitionNode } from "graphql";

import ApolloClient from "apollo-client";
import gql from "graphql-tag";
import { createHttpLink } from "apollo-link-http";
import { WebSocketLink } from "apollo-link-ws";
import { InMemoryCache } from "apollo-cache-inmemory";
import fetch from 'node-fetch'
import * as ws from "ws";

// import { GraphQLEndpoint } from "graphql-config";
import { OutputChannel } from "vscode";
import { ApolloLink } from "apollo-link";
import type { SchemaPointer } from "graphql-config";
import type { UserVariables } from "./graphql-content-provider";

export class NetworkHelper {
  private outputChannel: OutputChannel;

  constructor(outputChannel: OutputChannel) {
    this.outputChannel = outputChannel;
  }

  async executeOperation({
    endpoint,
    literal,
    variables,
    updateCallback
  }: ExecuteOperationOptions) {
    const operation = (literal.ast.definitions[0] as OperationDefinitionNode)
      .operation;
    try {
      console.log("attempt query")


      this.outputChannel.appendLine(`NetworkHelper: operation: ${operation}`);
      this.outputChannel.appendLine(`NetworkHelper: endpoint: ${endpoint[0]}`);
      console.log('before link', endpoint[0])
      const httpLink = createHttpLink({
        uri: endpoint[0],
        fetch
      });
      console.log('created http link')

      const wsEndpointURL = endpoint[0].replace(/^http/, "ws");
      const wsLink = new WebSocketLink({
        uri: wsEndpointURL,
        options: {
          reconnect: true,
          inactivityTimeout: 30000
        },
        webSocketImpl: ws
      });
      console.log('getting client')
      const apolloClient = new ApolloClient({
        link: ApolloLink.split(
          () => {
            return operation === "subscription";
          },
          wsLink,
          httpLink
        ),
        cache: new InMemoryCache({
          addTypename: false
        })
      });

      console.log('client')

      const parsedOperation = gql`
      ${literal.content}
    `;

      if (operation === "subscription") {
        apolloClient
          .subscribe({
            query: parsedOperation,
            variables
          })
          .subscribe({
            next(data: any) {
              updateCallback(formatData(data), operation);
            }
          });
      } else {
        try {
          console.log('something')
          if (operation === "query") {
            console.log("attempt query", { variables });
            console.log('another log');
            const data = await apolloClient
              .query({
                query: parsedOperation,
                variables
              })
            console.log('data', data)
            if (!data.errors || !data.data.match('Error')) {
              updateCallback(formatData(data), operation);
            }
            else {
              throw new Error(data.errors ? data.errors.toString() : data.data)
            }

          } else {
            const data = await apolloClient
              .mutate({
                mutation: parsedOperation,
                variables
              })
            updateCallback(formatData(data), operation);
          }
        }
        catch (err) {
          console.error({ err })
          updateCallback(err.toString(), operation);
        }
      }
    }
    catch (err) {
      updateCallback(err.toString(), operation);
    }
  }
}

export interface ExecuteOperationOptions {
  endpoint: SchemaPointer;
  literal: ExtractedTemplateLiteral;
  variables: UserVariables;
  updateCallback: (data: string, operation: string) => void;
}

function formatData({ data, errors }: any) {
  return JSON.stringify({ data, errors }, null, 2);
}
