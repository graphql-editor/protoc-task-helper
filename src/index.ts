#!/usr/bin/env node
import yargs from "yargs";
import { exec } from "child_process";
import { mkdir } from "fs";
import { promisify } from "util";
import { glob } from "glob";
import rimraf from "rimraf";
const execPromise = promisify(exec);
const rimrafPromise = promisify(rimraf);
const mkdirPromise = promisify(mkdir);
const globPromise = promisify(glob);

const options = {
  "proto-pattern": {
    type: "string",
    default: "./proto/**/*.proto",
    describe: "Proto files search pattern",
  },
  includes: {
    type: "array",
    default: ["proto"],
    describe: "Proto include paths used in generation",
  },
} as const;

function template(out: string) {
  return (s: string) => new Function("return `" + s + "`;").call({ out });
}

type OptionList = string[];
interface ProtocTaskOptions {
  protoCmd: OptionList[];
  protoPattern: string;
  out: string;
  includes: string[] | readonly ["proto"];
}
async function protocTask({
  protoCmd,
  protoPattern,
  out,
  includes,
}: ProtocTaskOptions) {
  const files = await globPromise(protoPattern);
  await rimrafPromise(out);
  await mkdirPromise(out);
  const includeOpts = includes.map((v) => `-I${v}`);
  for (const p of protoCmd) {
    await execPromise(
      ["protoc", ...includeOpts, ...p.map(template(out)), ...files].join(" ")
    );
  }
}

type NameOptsTuple = [string, OptionList[]];
const genSettigns: Array<NameOptsTuple> = [
  [
    "ts/node",
    [
      [
        "--js_out=import_style=commonjs,binary:${this.out}",
        "--grpc_out=grpc_js:${this.out}",
        "--plugin=protoc-gen-grpc=./node_modules/.bin/grpc_tools_node_protoc_plugin",
      ],
      [
        "--plugin=protoc-gen-ts=./node_modules/.bin/protoc-gen-ts",
        "--ts_out=grpc_js:${this.out}",
      ],
    ],
  ],
  [
    "ts/web",
    [
      [
        "--js_out=import_style=commonjs:${this.out}",
        "--plugin=protoc-gen-grpc=./node_modules/.bin/",
        "--grpc-web_out=import_style=commonjs+dts,mode=grpcwebtext:${this.out}",
      ],
    ],
  ],
  [
    "go",
    [
      [
        "--go_out=${this.out}",
        "--go_opt=paths=source_relative",
        "--go-grpc_out=${this.out}",
        "--go-grpc_opt=paths=source_relative",
      ],
    ],
  ],
];

Promise.resolve(yargs(process.argv.slice(2)).options(options).argv)
  .then((args) =>
    Promise.all(
      genSettigns.map(([out, protoCmd]) =>
        protocTask({
          ...args,
          protoCmd,
          out,
          protoPattern: args["proto-pattern"],
        })
      )
    )
  )
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
