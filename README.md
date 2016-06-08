# kubesync

`kubesync` is a small command line tool that makes it easy to deploy local config files (json and yaml) to ssh-proxied kubernetes cluster.

## Getting Started

### Prerequisities

- NodeJS >= 4.2

### Installing
```
npm i kubesync -g
```
Now you can type `kubesync --help` to run it.

## Usage

### SSH Connection

To use this tool, there must be a proxied ssh connection with kubernetes cluster.
```
ssh user@X.X.X.X -L 8080:127.0.0.1:8080
```

### CLI
```
Usage: kubesync <folder> [options]

  Options:

    -h, --help     output usage information
    -V, --version  output the version number
    -d, --dry-run  run the script without any changes on remote k8s for test purposes
```

## Example
Go to the folder that contains all k8s cluster config files, and run:
```
kubesync .
```

## How does it work?

If you run the command above, `kubesync` will scan all the files in current folder  (`.`) recursively with `.json` and `.yaml` extension. Then it will parse these configs to determine resource type. Currently just `ReplicationController` and `Service` kinds are supported.

These replication controllers and services will be compared to remote ones.

- If there is no remote resource with same `metadata.name` and `kind`: It will create new resource.
- If there is a remote resource with same `metadata.name` and `kind`: It will compare some fields. If they're not matched, updates the remote resource. If they're matched, does nothing.

Fields to check for ReplicationControllers:
- `spec.template.spec.containers[].image`
- `spec.template.spec.containers[].command`
- `spec.template.spec.containers[].env`

Fields to check for Services:
- `spec.ports[].port`
- `spec.ports[].targetPort`
- `spec.selector.name`

## Development

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes.

Clone this repo

```
git clone https://github.com/signalive/kubesync.git
```

Install dependencies

```
npm i -g
```

Now you can call `kubesync` globally. Into order to update global `kubesync` for development purposes, run:

```
npm link
```

