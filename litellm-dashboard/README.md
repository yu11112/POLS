# LiteLLM 多账号用量可视化面板

一套开箱即用的方案：用 LiteLLM 把多个 OpenAI API Key（或其他兼容 provider）合并成一个统一入口，
同时用内置的 Tracker + Dashboard 实时看到每个账号消耗了多少、还剩多少。

## 目录结构

```
litellm-dashboard/
├── docker-compose.yml          # 一键启动 LiteLLM + Tracker + Dashboard
├── .env.example                # 环境变量模板（API Key、预算等）
├── litellm/
│   ├── config.yaml             # LiteLLM 路由配置（多 Key + callback）
│   └── callback_handler.py     # 把每次成功调用推送到 Tracker
├── tracker/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py                 # FastAPI + SQLite，聚合用量 & 提供 REST API
│   └── budgets.yaml            # 每个账号的月度预算
└── dashboard/
    ├── Dockerfile
    ├── nginx.conf              # 前端静态资源 + /api 反代到 tracker
    └── public/
        ├── index.html          # 可视化面板
        └── app.js              # 卡片 + 进度条 + Chart.js 折线图
```

## 三个组件做什么

| 组件         | 端口  | 作用                                                           |
|--------------|-------|----------------------------------------------------------------|
| LiteLLM      | 4000  | OpenAI 兼容入口，多 Key 负载均衡、重试、fallback                |
| Tracker      | 8000  | 接收 LiteLLM 的 success callback，落库，按账号/日/模型聚合      |
| Dashboard    | 8080  | 浏览器打开就能看到每个账号的消耗、余额、请求量、token 趋势       |

## 快速开始

```bash
cd litellm-dashboard
cp .env.example .env
# 编辑 .env 填入你的 OpenAI API Key
docker compose up -d
```

访问：
- 面板：<http://localhost:8080>
- LiteLLM 入口：<http://localhost:4000>
- Tracker API：<http://localhost:8000/docs>

## 你的应用如何调用

LiteLLM 是 **OpenAI 完全兼容**的，只改 `base_url`：

```python
from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:4000",
    api_key="sk-your-master-key",   # .env 里的 LITELLM_MASTER_KEY
)
client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "hi"}],
)
```

## 怎么配预算

编辑 `tracker/budgets.yaml`：

```yaml
accounts:
  account-1:
    label: "主账号 (Team)"
    monthly_budget_usd: 200
  account-2:
    label: "备用账号"
    monthly_budget_usd: 50
```

面板会自动显示 `已用 / 预算` 进度条、剩余金额和预计耗尽时间。

## 面板截图（字段说明）

每个账号一张卡片，包含：

- **已用 / 预算** 进度条（颜色：绿 < 70%，黄 70-90%，红 > 90%）
- **本月消耗 USD** 与 **剩余 USD**
- **请求数 / 总 tokens / prompt tokens / completion tokens**
- **按模型拆分** 的小表格
- **近 30 天消耗曲线**（Chart.js）

顶部还有一个汇总卡片，显示所有账号合计。
